'use strict';
// Adobe Acrobat Sign (REST API v6). The account connects once with an
// integration key (Acrobat Sign → Account → Acrobat Sign API → API
// Information → Integration Key). Documents are uploaded as transient
// documents, sent as agreements, and polled for progress (webhooks would need
// a public web address). Signed copies are downloaded and kept in the CRM.
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');

const apiRoot = () => (process.env.ADOBE_SIGN_API_URL || 'https://api.adobesign.com').replace(/\/+$/, '');
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};
const REMINDERS = { daily: 'DAILY_UNTIL_SIGNED', every_3_days: 'EVERY_THIRD_DAY_UNTIL_SIGNED', weekly: 'WEEKLY_UNTIL_SIGNED' };
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const CHECK_EVERY_MS = 10 * 60 * 1000;

// ---- Connection ------------------------------------------------------------------

function connection() {
  const key = db.getSetting('adobe_sign_key', '');
  return key ? {
    key: decrypt(key),
    api: db.getSetting('adobe_sign_api', ''),
    web: db.getSetting('adobe_sign_web', ''),
    account: db.getSetting('adobe_sign_account', ''),
    sendAsUser: db.getSetting('adobe_sign_send_as_user', '0') === '1',
  } : null;
}

const isConnected = () => Boolean(db.getSetting('adobe_sign_key', ''));

// Adobe hands back the data-centre address to use (e.g. api.au1.adobesign.com);
// only Adobe's own hosts (or the configured test server) are accepted.
function trustedBase(url) {
  const clean = String(url || '').replace(/\/+$/, '');
  if (clean === apiRoot() || clean.startsWith(`${apiRoot()}/`)) return clean;
  let host;
  try { host = new URL(clean).hostname; } catch { return null; }
  return /^https:/.test(clean) && /(^|\.)(adobesign|echosign)\.com$/i.test(host) ? clean : null;
}

async function call(base, key, method, path, { json, form, raw = false, asUser = null } = {}) {
  const headers = { Authorization: `Bearer ${key}` };
  if (asUser) headers['x-api-user'] = `email:${asUser}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(`${base}/api/rest/v6${path}`, { method, headers, body });
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(res.status === 401
      ? 'Adobe Sign rejected the integration key – it may have been revoked. Please reconnect in Settings.'
      : `Adobe Sign: ${data.message || data.code || `request failed (${res.status})`}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function api(method, path, opts = {}) {
  const c = connection();
  if (!c) throw new HttpError(400, 'Connect Adobe Sign in Settings first');
  const base = trustedBase(c.api);
  if (!base) throw new HttpError(400, 'Adobe Sign connection needs refreshing – reconnect it in Settings');
  return call(base, c.key, method, path, opts);
}

async function connect(rawKey) {
  const key = String(rawKey || '').trim();
  if (key.length < 20) throw new HttpError(400, 'Paste the full integration key from Adobe Acrobat Sign');
  let uris;
  let me;
  try {
    uris = await call(apiRoot(), key, 'GET', '/baseUris');
    const base = trustedBase(uris.apiAccessPoint);
    if (!base) throw new Error('Adobe Sign returned an unexpected server address');
    me = await call(base, key, 'GET', '/users/me');
    db.setSetting('adobe_sign_api', base);
  } catch (err) {
    throw new HttpError(400, err.status === 401 ? 'Adobe Sign didn\'t accept that integration key. Check you copied all of it, and that it has the agreement scopes.' : err.message);
  }
  db.setSetting('adobe_sign_key', encrypt(key));
  db.setSetting('adobe_sign_web', trustedBase(uris.webAccessPoint) || '');
  db.setSetting('adobe_sign_account', [me.firstName, me.lastName].filter(Boolean).join(' ') ? `${[me.firstName, me.lastName].filter(Boolean).join(' ')} (${me.email})` : me.email || 'Connected');
  return status();
}

function setSendAsUser(on) {
  db.setSetting('adobe_sign_send_as_user', on ? '1' : '0');
  return status();
}

function disconnect() {
  for (const k of ['adobe_sign_key', 'adobe_sign_api', 'adobe_sign_web', 'adobe_sign_account']) db.setSetting(k, '');
}

function status() {
  const c = connection();
  return { connected: Boolean(c), account: c?.account || null, send_as_user: Boolean(c?.sendAsUser) };
}

// ---- Sending ---------------------------------------------------------------------------

function fileFrom(input) {
  const m = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(input?.data || ''));
  const name = String(input?.name || '').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
  const ext = name.split('.').pop().toLowerCase();
  if (!m || !name) throw new HttpError(400, 'Choose a document to send');
  if (!FILE_TYPES[ext]) throw new HttpError(400, 'Adobe Sign documents need to be PDF or Word (.pdf, .docx, .doc)');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw new HttpError(400, 'That file is empty');
  if (data.length > MAX_FILE) throw new HttpError(400, 'That file is too large (max 10 MB)');
  if (ext === 'pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file doesn\'t look like a PDF');
  return { name, mime: FILE_TYPES[ext], data };
}

function cleanSigners(list) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const email = String(s?.email || '').trim().toLowerCase();
    const name = String(s?.name || '').trim();
    if (!email && !name) continue;
    if (!EMAIL_RE.test(email)) throw new HttpError(400, `${name || 'A signer'} needs a valid email address`);
    if (seen.has(email)) throw new HttpError(400, `${email} is listed twice`);
    seen.add(email);
    out.push({ name: name || email, email, contact_id: Number(s.contact_id) || null });
  }
  if (!out.length) throw new HttpError(400, 'Add at least one person to sign');
  if (out.length > 10) throw new HttpError(400, 'Up to 10 signers per document');
  return out;
}

const rowOut = (r) => {
  if (!r) return r;
  const { signed_pdf: pdf, ...rest } = r;
  return { ...rest, signers: JSON.parse(r.signers || '[]'), has_signed_pdf: Boolean(pdf) };
};

const get = (id) => rowOut(db.one('SELECT * FROM sign_requests WHERE id = ?', id));

function list({ contactId = null, dealId = null } = {}) {
  const where = [];
  const params = [];
  if (contactId) {
    const ids = require('./household').householdIds(contactId);
    where.push(`r.contact_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (dealId) { where.push('r.deal_id = ?'); params.push(dealId); }
  return db.all(
    `SELECT r.*, u.name AS sender_name, d.title AS deal_title FROM sign_requests r
     LEFT JOIN users u ON u.id = r.sender_user_id LEFT JOIN deals d ON d.id = r.deal_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT 100`,
    ...params,
  ).map(rowOut);
}

// Sends a document for signature. `signers` sign in the order given when
// order = 'sequential', otherwise all at once; the broker can countersign last.
async function send(input, user) {
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', input.contact_id);
  if (!contact) throw new HttpError(404, 'Contact not found');
  const dealId = Number(input.deal_id) || null;
  if (dealId && !db.one('SELECT 1 FROM deals WHERE id = ? AND (contact_id = ? OR id IN (SELECT deal_id FROM deal_borrowers WHERE contact_id = ?))', dealId, contact.id, contact.id)) {
    throw new HttpError(400, 'That deal belongs to a different client');
  }
  const documentId = Number(input.document_id) || null;
  if (documentId && !db.one('SELECT 1 FROM documents WHERE id = ? AND deal_id = ?', documentId, dealId)) throw new HttpError(400, 'That checklist item isn\'t on this deal');

  let file;
  if (input.review_id) {
    const r = db.one('SELECT * FROM reviews WHERE id = ?', input.review_id);
    if (!r || !require('./household').householdIds(contact.id).includes(r.contact_id)) throw new HttpError(400, 'Lending review not found for this client');
    const review = require('./review');
    file = { name: review.fileName(r, 'pdf'), mime: FILE_TYPES.pdf, data: await review.renderPdf(review.model(r)) };
  } else {
    file = fileFrom(input.file);
  }
  const name = String(input.name || '').trim() || file.name.replace(/\.[^.]+$/, '');
  if (name.length > 255) throw new HttpError(400, 'That document name is too long');
  const signers = cleanSigners(input.signers);
  const sequential = input.order === 'sequential';
  signers.forEach((s, i) => { s.order = sequential ? i + 1 : 1; });
  if (input.broker_signs) {
    if (!user.email || signers.some((s) => s.email === user.email.toLowerCase())) throw new HttpError(400, 'You\'re already in the signer list');
    signers.push({ name: user.name, email: user.email.toLowerCase(), contact_id: null, order: Math.max(...signers.map((s) => s.order)) + 1, is_sender: true });
  }
  for (const s of signers) s.status = s.order === 1 ? 'waiting' : 'not_yet';
  const message = String(input.message || '').trim().slice(0, 1000) || null;
  const reminder = REMINDERS[input.reminder] || null;
  const expiresDays = Number(input.expires_days) || null;
  if (expiresDays !== null && (expiresDays < 1 || expiresDays > 365)) throw new HttpError(400, 'Expiry must be between 1 and 365 days');

  const c = connection();
  if (!c) throw new HttpError(400, 'Connect Adobe Sign in Settings first');
  const id = db.insert('sign_requests', {
    contact_id: contact.id, deal_id: dealId, document_id: documentId, name, file_name: file.name, message,
    status: 'sending', signers: JSON.stringify(signers), sender_user_id: user.id,
  });
  const asUser = c.sendAsUser ? user.email : null;
  try {
    const form = new FormData();
    form.append('File-Name', file.name);
    form.append('Mime-Type', file.mime);
    form.append('File', new Blob([file.data], { type: file.mime }), file.name);
    const { transientDocumentId } = await api('POST', '/transientDocuments', { form, asUser });
    const agreement = {
      fileInfos: [{ transientDocumentId }],
      name,
      participantSetsInfo: signers.map((s) => ({ memberInfos: [{ email: s.email }], order: s.order, role: 'SIGNER', label: s.name })),
      signatureType: 'ESIGN',
      state: 'IN_PROCESS',
      ...(message ? { message } : {}),
      ...(reminder ? { reminderFrequency: reminder } : {}),
      ...(expiresDays ? { expirationTime: new Date(Date.now() + expiresDays * 86400000).toISOString() } : {}),
      externalId: { id: `efh-crm-${id}` },
    };
    const created = await api('POST', '/agreements', { json: agreement, asUser });
    db.update('sign_requests', id, { agreement_id: created.id, status: 'out_for_signature', adobe_status: 'OUT_FOR_SIGNATURE', sent_at: nowIso(), last_checked_at: nowIso() });
  } catch (err) {
    db.update('sign_requests', id, { status: 'failed', error: err.message });
    // Adobe's own errors (including a revoked key) are reported as a 502, never
    // a 401, which would sign the broker out of the CRM.
    throw err instanceof HttpError ? err : new HttpError(502, err.message);
  }
  const who = signers.filter((s) => !s.is_sender).map((s) => s.name).join(', ');
  db.insert('activities', { contact_id: contact.id, deal_id: dealId, user_id: user.id, type: 'system', body: `Sent for signing via Adobe Sign: ${name} (to ${who}${input.broker_signs ? ', then you' : ''})` });
  return get(id);
}

// ---- Tracking ------------------------------------------------------------------------------

const DONE = ['signed', 'declined', 'cancelled', 'expired', 'failed'];
const SIGNER_STATUS = (s) => {
  const v = String(s || '').toUpperCase();
  if (v === 'COMPLETED') return 'signed';
  if (/DECLIN|REJECT/.test(v)) return 'declined';
  if (v === 'NOT_YET_VISIBLE') return 'not_yet';
  if (v === 'CANCELLED' || v === 'EXPIRED') return v.toLowerCase();
  return 'waiting';
};

// Checks Adobe for progress, records who has signed, and on completion keeps
// the signed PDF, logs it, notifies the sender and ticks off the checklist item.
async function refresh(id) {
  const r = db.one('SELECT * FROM sign_requests WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Not found');
  if (!r.agreement_id || DONE.includes(r.status)) return get(id);
  const info = await api('GET', `/agreements/${encodeURIComponent(r.agreement_id)}`);
  const members = await api('GET', `/agreements/${encodeURIComponent(r.agreement_id)}/members`);
  const signers = JSON.parse(r.signers);
  for (const set of members.participantSets || []) {
    for (const m of set.memberInfos || []) {
      const s = signers.find((x) => x.email === String(m.email || '').toLowerCase());
      if (s) s.status = SIGNER_STATUS(set.status || m.status);
    }
  }
  const adobe = String(info.status || '').toUpperCase();
  let next = r.status;
  if (adobe === 'SIGNED' || adobe === 'APPROVED') next = 'signed';
  else if (signers.some((s) => s.status === 'declined')) next = 'declined';
  else if (adobe === 'CANCELLED') next = 'cancelled';
  else if (adobe === 'EXPIRED') next = 'expired';
  const patch = { adobe_status: adobe || null, signers: JSON.stringify(signers), last_checked_at: nowIso(), error: null };
  if (next === 'signed') {
    for (const s of signers) s.status = 'signed';
    patch.signers = JSON.stringify(signers);
    patch.signed_pdf = await api('GET', `/agreements/${encodeURIComponent(r.agreement_id)}/combinedDocument`, { raw: true });
    patch.completed_at = nowIso();
  } else if (next !== r.status) {
    patch.completed_at = nowIso();
  }
  db.update('sign_requests', id, { ...patch, status: next });
  if (next !== r.status) onFinished({ ...r, status: next });
  return get(id);
}

function onFinished(r) {
  const text = {
    signed: `Document signed: ${r.name}`,
    declined: `Document declined: ${r.name}`,
    cancelled: `Signing cancelled: ${r.name}`,
    expired: `Signing request expired: ${r.name}`,
  }[r.status];
  if (!text) return;
  const contact = db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', r.contact_id);
  db.insert('activities', { contact_id: r.contact_id, deal_id: r.deal_id, type: 'system', body: `${text} (Adobe Sign)` });
  if (r.sender_user_id) {
    db.insert('notifications', {
      user_id: r.sender_user_id,
      message: `${text}${contact ? ` – ${[contact.first_name, contact.last_name].filter(Boolean).join(' ')}` : ''}`,
      link: r.deal_id ? `#/deals/${r.deal_id}` : `#/contacts/${r.contact_id}`,
    });
  }
  if (r.status === 'signed') {
    if (r.document_id) db.run("UPDATE documents SET status = 'received' WHERE id = ? AND status IN ('required','requested')", r.document_id);
    require('./automation').emit('document.signed', { contactId: r.contact_id, dealId: r.deal_id, document_name: r.name });
  }
}

// Called by the scheduler: checks open requests not checked in the last 10 minutes.
async function syncOpen(log = console) {
  if (!isConnected()) return 0;
  const cutoff = new Date(Date.now() - CHECK_EVERY_MS).toISOString();
  const open = db.all("SELECT id FROM sign_requests WHERE status = 'out_for_signature' AND (last_checked_at IS NULL OR last_checked_at < ?)", cutoff);
  let finished = 0;
  for (const { id } of open) {
    try {
      const r = await refresh(id);
      if (DONE.includes(r.status)) finished++;
    } catch (err) {
      db.update('sign_requests', id, { last_checked_at: nowIso(), error: err.message });
      log.error?.(`[adobe sign] ${err.message}`);
      if (err.status === 401) break;
    }
  }
  return finished;
}

async function remind(id, note) {
  const r = db.one('SELECT * FROM sign_requests WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Not found');
  if (r.status !== 'out_for_signature') throw new HttpError(400, 'Only documents waiting for signature can be chased');
  const members = await api('GET', `/agreements/${encodeURIComponent(r.agreement_id)}/members`);
  const ids = (members.participantSets || [])
    .filter((set) => ['WAITING_FOR_MY_SIGNATURE', 'WAITING_FOR_MY_APPROVAL', 'ACTIVE'].includes(String(set.status).toUpperCase()))
    .flatMap((set) => (set.memberInfos || []).map((m) => m.id)).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'Nobody is currently waiting to sign');
  await api('POST', `/agreements/${encodeURIComponent(r.agreement_id)}/reminders`, {
    json: { recipientParticipantIds: ids, status: 'ACTIVE', ...(note ? { note: String(note).slice(0, 500) } : {}) },
  });
  db.insert('activities', { contact_id: r.contact_id, deal_id: r.deal_id, type: 'system', body: `Adobe Sign reminder sent: ${r.name}` });
  return { reminded: ids.length };
}

async function cancel(id, reason, user) {
  const r = db.one('SELECT * FROM sign_requests WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Not found');
  if (r.status !== 'out_for_signature') throw new HttpError(400, 'This document isn\'t waiting for signature');
  await api('PUT', `/agreements/${encodeURIComponent(r.agreement_id)}/state`, {
    json: { state: 'CANCELLED', agreementCancellationInfo: { comment: String(reason || 'Cancelled by your broker').slice(0, 500), notifyOthers: true } },
  });
  db.update('sign_requests', id, { status: 'cancelled', adobe_status: 'CANCELLED', completed_at: nowIso() });
  db.insert('activities', { contact_id: r.contact_id, deal_id: r.deal_id, user_id: user.id, type: 'system', body: `Signing cancelled: ${r.name} (Adobe Sign)` });
  return get(id);
}

function signedPdf(id) {
  const r = db.one('SELECT name, signed_pdf FROM sign_requests WHERE id = ?', id);
  if (!r?.signed_pdf) throw new HttpError(404, 'No signed copy yet');
  return { name: `${r.name.replace(/[^\w .,&()-]+/g, '').trim() || 'Signed document'} (signed).pdf`, data: Buffer.from(r.signed_pdf) };
}

module.exports = {
  connect, disconnect, setSendAsUser, status, isConnected, send, list, get, refresh, syncOpen, remind, cancel, signedPdf, REMINDERS, trustedBase,
};
