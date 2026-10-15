'use strict';
// Online fact find and document requests. The broker sends a private link;
// the client fills in a branded, adaptive fact find (or just uploads the
// documents asked for), and the broker reviews it and imports it into the CRM.
const crypto = require('node:crypto');
const db = require('../db');
const rules = require('../../public/js/factfind/rules.js');
const branding = require('./branding');
const household = require('./household');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, today, addDays, formatDate, HttpError } = require('../util');

const KINDS = ['full', 'documents'];
const { yes } = rules;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 150;
const MAX_ANSWERS_BYTES = 400 * 1024;
const DEFAULT_DAYS = 30;

// ---- Links ------------------------------------------------------------------------------------------

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const appBase = () => (process.env.APP_URL || db.getSetting('app_url', '') || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const linkFor = (row) => `${appBase()}/f/${decrypt(row.token_enc)}`;
// Clients can only open the link if the CRM is reachable from the internet.
function reachability() {
  const base = appBase();
  const local = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(base);
  return { base, public: !local, https: base.startsWith('https://') };
}

function load(id) {
  const r = db.one('SELECT * FROM fact_finds WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Fact find not found');
  return r;
}
const parse = (v, fallback) => {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};

// ---- Pre-filling from the CRM ------------------------------------------------------------------------

const EMPLOYMENT_FROM_CRM = { payg: 'full_time', casual: 'casual', contractor: 'contract', self_employed: 'self_employed', retired: 'retired' };
const EMPLOYMENT_TO_CRM = { full_time: 'payg', part_time: 'payg', parental_leave: 'payg', casual: 'casual', contract: 'contractor', self_employed: 'self_employed', retired: 'retired' };
const LIABILITY_FROM_CRM = { home_loan: 'home_loan', investment_loan: 'home_loan', line_of_credit: 'home_loan', construction: 'home_loan', bridging: 'home_loan', credit_card: 'credit_card', personal: 'personal', car: 'car', hecs: 'hecs', business_loan: 'business_loan' };
const ASSET_FROM_CRM = { savings: 'savings', superannuation: 'superannuation', shares: 'shares', vehicle: 'vehicle', business: 'business', contents: 'contents' };
const month = (d) => (d ? String(d).slice(0, 7) : '');

function applicantFromContact(c) {
  const job = { id: rules.uid() };
  if (c.employment_type) job.type = EMPLOYMENT_FROM_CRM[c.employment_type] || '';
  if (c.employer) job[job.type === 'self_employed' ? 'business_name' : 'employer'] = c.employer;
  if (c.annual_income && job.type !== 'self_employed') { job.base = String(c.annual_income); job.base_freq = 'annually'; }
  return {
    id: `c${c.id}`, crm_id: c.id, first_name: c.first_name || '', last_name: c.last_name || '', email: c.email || '', mobile: c.mobile || c.phone || '',
    dob: c.dob || '', marital_status: c.marital_status || '', address: c.address || '', suburb: c.suburb || '', state: c.state || '', postcode: c.postcode || '',
    jobs: [job], prev_addresses: [], other_income: [],
  };
}

// A new fact find starts from the client's last one (if any), otherwise from
// what the CRM already knows, so the client only checks and adds.
function prefill(contactId, { includePartner = true } = {}) {
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
  const previous = db.one("SELECT answers FROM fact_finds WHERE contact_id = ? AND kind = 'full' AND status IN ('submitted','reviewed') AND answers IS NOT NULL ORDER BY id DESC LIMIT 1", contactId);
  if (previous) {
    const a = rules.normalise(JSON.parse(previous.answers));
    a.declaration = {};
    return a;
  }
  const partner = includePartner ? household.partnerOf(contactId) : null;
  const a = rules.emptyAnswers();
  a.applicants = [applicantFromContact(contact)];
  if (partner) {
    a.applicants.push(applicantFromContact(db.one('SELECT * FROM contacts WHERE id = ?', partner.id)));
    a.applying = 'joint';
  }
  if (contact.dependants !== null && contact.dependants !== undefined) a.household.dependants = String(contact.dependants);
  const owner = (contactIdA, coId) => {
    const ids = a.applicants.map((p) => p.crm_id);
    if (coId && ids.includes(coId) && ids.includes(contactIdA)) return 'joint';
    return a.applicants.find((p) => p.crm_id === contactIdA)?.id || a.applicants[0].id;
  };
  const position = require('./tracker').summary(contactId);
  const propIds = new Map();
  for (const p of position.properties.filter((x) => x.status !== 'sold')) {
    const id = rules.uid();
    propIds.set(p.id, id);
    a.properties.push({
      id, crm_id: p.id, address: p.address, value: p.current_value ? String(Math.round(p.current_value)) : '',
      usage: ['owner_occupied', 'investment', 'holiday', 'vacant'].includes(p.usage) ? p.usage : 'owner_occupied',
      rent: p.rental_income_weekly ? String(p.rental_income_weekly) : '', rent_freq: 'weekly', owner: owner(p.contact_id, p.co_owner_id),
    });
  }
  for (const n of position.loans.filter((x) => x.status === 'active')) {
    a.liabilities.push({
      id: rules.uid(), crm_id: n.id, type: LIABILITY_FROM_CRM[n.loan_type] || 'other', lender: n.lender_name || n.lender || '',
      balance: n.balance ? String(n.balance) : '', limit: n.limit_amount ? String(n.limit_amount) : '',
      repayment: n.repayment_amount ? String(n.repayment_amount) : '', repayment_freq: n.repayment_frequency || 'monthly',
      rate: n.interest_rate ? String(n.interest_rate) : '', rate_type: n.rate_type === 'fixed' ? 'fixed' : 'variable', fixed_expiry: month(n.fixed_expiry_date),
      property: (n.security_ids || []).map((sid) => propIds.get(sid)).find(Boolean) || '', owner: owner(n.contact_id, n.co_borrower_id),
    });
  }
  for (const s of position.assets || []) {
    a.assets.push({ id: rules.uid(), crm_id: s.id, type: ASSET_FROM_CRM[s.asset_type] || 'other', institution: s.institution || s.description || '', value: s.value ? String(s.value) : '', owner: owner(s.contact_id) });
  }
  return a;
}

// ---- Creating and sending --------------------------------------------------------------------------

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

function cleanRequests(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const label = cleanText(typeof r === 'string' ? r : r?.label, 200);
    if (!label || out.some((x) => x.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ key: `req-${crypto.randomBytes(4).toString('hex')}`, label, note: cleanText(r?.note, 300), category: 'requested' });
  }
  if (!out.length) throw new HttpError(400, 'Choose at least one document to request');
  return out.slice(0, 40);
}

const DEFAULT_MESSAGE = {
  full: 'To get things moving, I need some details about you, your finances and what you\'d like to achieve, plus a few documents. Please fill in this secure online fact find. It takes about 20 minutes, saves as you go, and you can come back to it any time.',
  documents: 'Could you please upload the documents below? You can take photos with your phone or upload files from your computer.',
};

function create({ contact_id: contactId, deal_id: dealId = null, kind = 'full', requests = null, message = '', to = '', include_partner: includePartner = true, expires_days: days = DEFAULT_DAYS, send = true, subject = '' }, userId) {
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', Number(contactId));
  if (!contact) throw new HttpError(404, 'Contact not found');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Choose a fact find or a document request');
  if (dealId && !db.one('SELECT 1 FROM deals WHERE id = ?', Number(dealId))) throw new HttpError(404, 'Deal not found');
  const email = cleanText(to, 200) || contact.email || '';
  if (send && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, `Add an email address for ${contact.first_name} first`);
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresDays = Math.min(90, Math.max(1, Math.round(Number(days) || DEFAULT_DAYS)));
  const row = {
    contact_id: contact.id, deal_id: dealId ? Number(dealId) : null, kind, token_hash: hashToken(token), token_enc: encrypt(token),
    answers: kind === 'full' ? JSON.stringify(prefill(contact.id, { includePartner: includePartner !== false })) : null,
    requests: kind === 'documents' ? JSON.stringify(cleanRequests(requests)) : null,
    message: cleanText(message, 3000) || DEFAULT_MESSAGE[kind], sent_to: send ? email : null, created_by: userId || null,
    expires_at: `${addDays(today(), expiresDays)}T23:59:59.000Z`,
  };
  const id = db.insert('fact_finds', row);
  db.insert('activities', {
    contact_id: contact.id, deal_id: row.deal_id, user_id: userId || null, type: 'system',
    body: `${kind === 'full' ? 'Online fact find' : 'Document request'} ${send ? `sent to ${email}` : 'created'}`,
  });
  if (send) sendLink(id, { to: email, subject }, userId);
  return id;
}

function documentsOf(row) {
  if (row.kind === 'documents') return parse(row.requests, []);
  return rules.documentsFor(parse(row.answers, null));
}

function emailBody(row, { reminder = false } = {}) {
  const contact = db.one('SELECT first_name FROM contacts WHERE id = ?', row.contact_id);
  const link = linkFor(row);
  const { emailParts: E } = require('./newsletter');
  const col = branding.emailColours();
  const until = formatDate(row.expires_at.slice(0, 10));
  const full = row.kind === 'full';
  const intro = reminder
    ? (full ? 'Just a reminder about your online fact find. Your answers are saved, so you can pick up where you left off.' : 'Just a reminder about the documents I asked for.')
    : row.message;
  const docs = row.kind === 'documents' ? documentsOf(row) : [];
  const button = full ? (row.status === 'sent' ? 'Start my fact find' : 'Continue my fact find') : 'Upload my documents';
  const text = [`Hi ${contact.first_name},`, intro, docs.length ? `Documents:\n${docs.map((d) => `- ${d.label}${d.note ? ` (${d.note})` : ''}`).join('\n')}` : '',
    `${button}: ${link}`, `This secure link is just for you and works until ${until}.`].filter(Boolean).join('\n\n');
  const html = [
    E.para(`Hi ${contact.first_name},`, col), E.para(intro, col),
    docs.length ? `<ul style="margin:0 0 14px 18px;padding:0;font-family:${E.FONT};font-size:15px;line-height:1.6;color:${E.TEXT};">${docs.map((d) => `<li>${E.esc(d.label)}${d.note ? ` <span style="color:${E.MUTED};">(${E.esc(d.note)})</span>` : ''}</li>`).join('')}</ul>` : '',
    E.button(button, link, col),
    `<p style="margin:0 0 14px 0;font-family:${E.FONT};font-size:12px;color:${E.MUTED};">This secure link is just for you and works until ${E.esc(until)}. Please don't forward it.</p>`,
  ].join('\n');
  return { text, html };
}

function sendLink(id, { to, subject } = {}, userId, { reminder = false } = {}) {
  const row = load(id);
  if (['cancelled'].includes(row.status)) throw new HttpError(400, 'This request was cancelled');
  const contact = db.one('SELECT first_name, email, owner_id FROM contacts WHERE id = ?', row.contact_id);
  const email = cleanText(to, 200) || row.sent_to || contact.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new HttpError(400, `Add an email address for ${contact.first_name} first`);
  const body = emailBody(row, { reminder });
  const business = db.getSetting('business_name', '') || 'us';
  const subj = cleanText(subject, 200) || (reminder ? `Reminder: ${row.kind === 'full' ? 'your fact find' : 'documents'} for ${business}`
    : row.kind === 'full' ? `Your fact find for ${business}` : `Documents needed for your loan with ${business}`);
  const outboxId = require('./mailer').queueEmail({
    to: email, subject: subj, body: body.text, htmlBody: body.html, contactId: row.contact_id, dealId: row.deal_id, senderUserId: contact.owner_id || userId || row.created_by,
  });
  db.update('fact_finds', id, { sent_to: email, updated_at: nowIso(), ...(reminder ? { reminded_at: nowIso(), reminders: row.reminders + 1 } : {}) });
  return outboxId;
}

function remind(id, userId) {
  const row = load(id);
  if (row.status === 'reviewed') throw new HttpError(400, 'This has already been completed');
  if (row.expires_at < nowIso()) throw new HttpError(400, 'The link has expired. Extend it first.');
  return sendLink(id, {}, userId, { reminder: true });
}

// Automatic reminders: 3 days after sending, then 4 days after that (if not finished).
function tick() {
  if (db.getSetting('fact_find_reminders', '1') === '0') return 0;
  const now = Date.now();
  let sent = 0;
  for (const r of db.all("SELECT * FROM fact_finds WHERE status IN ('sent','in_progress') AND reminders < 2 AND expires_at > ? AND sent_to IS NOT NULL", nowIso())) {
    const since = Date.parse(r.reminders ? r.reminded_at : r.created_at);
    const quiet = !r.last_saved_at || now - Date.parse(r.last_saved_at) > 2 * 86400000;
    if (now - since >= (r.reminders ? 4 : 3) * 86400000 && quiet) {
      try {
        sendLink(r.id, {}, null, { reminder: true });
        sent += 1;
      } catch { /* e.g. no email address any more */ }
    }
  }
  return sent;
}

// ---- The client's side (by private link) ------------------------------------------------------------

function byToken(token) {
  const row = /^[\w-]{20,64}$/.test(String(token || '')) ? db.one('SELECT * FROM fact_finds WHERE token_hash = ?', hashToken(token)) : null;
  if (!row || row.status === 'cancelled') throw new HttpError(404, 'This link isn\'t valid any more. Please contact your broker for a new one.');
  if (row.expires_at < nowIso()) throw new HttpError(410, 'This link has expired. Please contact your broker for a new one.');
  return row;
}

function filesOf(id) {
  return db.all('SELECT id, doc_key, doc_label, filename, mime, size, created_at FROM fact_find_files WHERE fact_find_id = ? ORDER BY id', id);
}

function publicView(row) {
  if (!row.opened_at) {
    db.update('fact_finds', row.id, { opened_at: nowIso() });
    db.insert('activities', { contact_id: row.contact_id, deal_id: row.deal_id, type: 'system', body: `${row.kind === 'full' ? 'Online fact find' : 'Document request'} opened by the client` });
  }
  const contact = db.one('SELECT first_name, owner_id FROM contacts WHERE id = ?', row.contact_id);
  const broker = db.one('SELECT name, email, phone FROM users WHERE id = ?', contact.owner_id || row.created_by) || {};
  const b = branding.getBrand();
  const col = branding.emailColours();
  return {
    kind: row.kind, status: row.status, locked: ['submitted', 'reviewed'].includes(row.status), first_name: contact.first_name,
    message: row.message, expires_at: row.expires_at, step: row.step,
    answers: row.kind === 'full' ? rules.normalise(parse(row.answers, null)) : null,
    requests: row.kind === 'documents' ? parse(row.requests, []) : null,
    files: filesOf(row.id).map(({ id, doc_key: key, filename, size, created_at: at }) => ({ id, doc_key: key, filename, size, created_at: at })),
    brand: {
      business_name: b.business_name, logo: b.logo?.url || null, primary: b.primary, on_primary: col.onPrimary, link: col.link, dark: col.dark, soft: col.soft,
      phone: db.getSetting('business_phone', ''), email: db.getSetting('business_email', ''), website: db.getSetting('business_website', ''), acl: db.getSetting('acl_number', ''),
    },
    broker: { name: broker.name || '', email: broker.email || '', phone: broker.phone || '' },
  };
}

// Keeps answers to a sensible size and shape (they're shown back to the broker).
function cleanAnswers(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === 'string') return v.slice(0, 4000);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => cleanAnswers(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 200)) if (/^[\w-]{1,60}$/.test(k)) out[k] = cleanAnswers(x, depth + 1);
    return out;
  }
  return null;
}

function publicSave(row, { answers, step } = {}) {
  if (row.kind !== 'full') throw new HttpError(400, 'Nothing to save');
  if (['submitted', 'reviewed'].includes(row.status)) throw new HttpError(400, 'Your fact find has already been sent to your broker');
  const clean = rules.normalise(cleanAnswers(answers));
  const json = JSON.stringify(clean);
  if (json.length > MAX_ANSWERS_BYTES) throw new HttpError(413, 'That\'s too much information to save');
  db.update('fact_finds', row.id, {
    answers: json, step: rules.STEPS.some(([k]) => k === step) ? step : row.step, status: 'in_progress', last_saved_at: nowIso(), updated_at: nowIso(),
  });
  return { saved_at: nowIso() };
}

function publicSubmit(row, body = {}) {
  if (['submitted', 'reviewed'].includes(row.status)) throw new HttpError(400, 'Already sent – thank you!');
  if (row.kind === 'full') {
    if (body.answers) publicSave(row, body);
    const a = rules.normalise(parse(db.one('SELECT answers FROM fact_finds WHERE id = ?', row.id).answers, null));
    const missing = [];
    if (!a.applicants[0].first_name) missing.push('your name');
    if (!a.goal.purpose) missing.push('what you\'d like to do');
    if (!a.declaration.privacy || !a.declaration.true_and_correct) missing.push('the declaration');
    if (!cleanText(a.declaration.signature, 120)) missing.push('your name as your signature');
    if (missing.length) throw new HttpError(400, `Please complete ${missing.join(', ')} before sending.`);
  }
  db.update('fact_finds', row.id, { status: 'submitted', submitted_at: nowIso(), updated_at: nowIso() });
  const contact = db.one('SELECT id, first_name, last_name, owner_id FROM contacts WHERE id = ?', row.contact_id);
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const outstanding = outstandingDocs(row.id).filter((d) => !d.optional).length;
  const what = row.kind === 'full' ? 'fact find' : 'documents';
  db.insert('activities', { contact_id: contact.id, deal_id: row.deal_id, type: 'system', body: `Client completed their online ${what}${outstanding ? ` (${outstanding} document${outstanding === 1 ? '' : 's'} still to come)` : ''}` });
  const brokerId = contact.owner_id || row.created_by;
  if (brokerId) {
    db.insert('notifications', { user_id: brokerId, message: `${name} completed their ${what}${outstanding ? ` (${outstanding} document${outstanding === 1 ? '' : 's'} to come)` : ''}`, link: `#/fact-finds/${row.id}` });
    emailBroker(row.id, brokerId, `${name} has completed their ${what}`);
  }
  require('./automation').emit('fact_find.submitted', { contactId: contact.id, dealId: row.deal_id || undefined, kind: row.kind, outstanding_documents: outstanding });
  return { ok: true };
}

function emailBroker(id, brokerId, subject) {
  const user = db.one('SELECT email FROM users WHERE id = ?', brokerId);
  if (!user?.email) return;
  const row = load(id);
  const lines = [`${subject}.`];
  if (row.kind === 'full') {
    for (const s of rules.summarise(parse(row.answers, null)).slice(0, 3)) {
      lines.push(`# ${s.title}`, ...s.groups.flatMap((g) => [g.heading, ...g.rows.map(([k, v]) => `- ${k}: ${v}`)]));
    }
  }
  const files = filesOf(id).length;
  lines.push(`${files} file${files === 1 ? '' : 's'} uploaded. Review it in the CRM: ${require('./reminders').crmUrl(`#/fact-finds/${id}`)}`);
  require('./mailer').queueEmail({ to: user.email, subject, body: lines.join('\n\n'), contactId: row.contact_id, internal: true, senderUserId: brokerId });
}

// ---- Files ------------------------------------------------------------------------------------------

const TYPES = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
};
// Works out the file type from its contents (not just its name).
function sniff(buf, filename) {
  const ext = (/\.([a-z0-9]+)$/i.exec(filename || '')?.[1] || '').toLowerCase();
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(head.subarray(8, 12).toString('latin1'))) return ext === 'heif' ? 'heif' : 'heic';
  if (head.subarray(0, 4).toString('hex') === '504b0304' && ['docx', 'xlsx'].includes(ext)) return ext;
  if (head.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1' && ['doc', 'xls'].includes(ext)) return ext;
  return null;
}
function cleanFilename(name, type) {
  let base = String(name || 'document').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]+/g, '').trim().slice(0, 120) || 'document';
  if (!new RegExp(`\\.${type}$`, 'i').test(base) && !(type === 'jpg' && /\.jpe?g$/i.test(base))) base = `${base.replace(/\.[a-z0-9]{1,5}$/i, '')}.${type}`;
  return base;
}

// Ticks the deal's document checklist when a matching file arrives.
const CHECKLIST = [
  [/photo id|passport|driver licence/i, 'Photo ID (driver licence / passport)'],
  [/medicare/i, 'Medicare card'],
  [/payslip/i, 'Last 2 payslips'],
  [/account your pay goes into|transaction/i, '3 months transaction statements'],
  [/savings|term deposit/i, '3 months savings statements'],
  [/savings|term deposit/i, 'Genuine savings evidence (3 months)'],
  [/savings|term deposit|gift/i, 'Deposit evidence'],
  [/credit card|personal loan|car loan|buy now|personal or car/i, 'Credit card & personal loan statements'],
  [/home loan/i, 'Current loan statements (6 months)'],
  [/personal tax returns/i, '2 years personal tax returns & NOAs'],
  [/business financial/i, '2 years company financials'],
  [/ato business portal/i, 'ATO portal statement'],
  [/contract of sale(?! for the (land|property you))|signed contract/i, 'Signed contract of sale'],
  [/rates notice/i, 'Rates notice'],
  [/lease|rental statements/i, 'Rental appraisal / lease agreement'],
  [/building contract/i, 'Fixed price building contract'],
  [/plans/i, 'Council approved plans & specs'],
];
function tickChecklist(row, label, fileId) {
  if (!row.deal_id) return 0;
  let n = 0;
  for (const [re, name] of CHECKLIST) {
    if (!re.test(label)) continue;
    n += Number(db.run("UPDATE documents SET status = 'received', link = COALESCE(link, ?), updated_at = ? WHERE deal_id = ? AND name = ? AND status IN ('required','requested')",
      `/api/fact-finds/files/${fileId}`, nowIso(), row.deal_id, name).changes);
  }
  return n;
}

function publicUpload(row, { doc_key: key, filename, data } = {}) {
  const doc = documentsOf(row).find((d) => d.key === key);
  if (!doc) throw new HttpError(400, 'Choose which document this is');
  if (row.status === 'reviewed') throw new HttpError(400, 'Your broker has already finished reviewing this. Please contact them.');
  if (typeof data !== 'string' || !data) throw new HttpError(400, 'No file received');
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'That file is empty');
  if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, 'That file is over 15 MB. Try a smaller scan or photo.');
  const type = sniff(buf, filename);
  if (!type) throw new HttpError(415, 'Please upload a PDF, a photo (JPG, PNG, HEIC) or a Word or Excel file');
  if (db.one('SELECT COUNT(*) AS n FROM fact_find_files WHERE fact_find_id = ?', row.id).n >= MAX_FILES) throw new HttpError(400, 'That\'s the most files we can take here. Please email any others to your broker.');
  const id = db.insert('fact_find_files', { fact_find_id: row.id, doc_key: key, doc_label: doc.label, filename: cleanFilename(filename, type), mime: TYPES[type], size: buf.length, data: buf });
  tickChecklist(row, doc.label, id);
  if (['submitted'].includes(row.status)) {
    const contact = db.one('SELECT first_name, last_name, owner_id FROM contacts WHERE id = ?', row.contact_id);
    const brokerId = contact.owner_id || row.created_by;
    const recent = db.one("SELECT 1 FROM notifications WHERE user_id = ? AND link = ? AND created_at > ?", brokerId, `#/fact-finds/${row.id}`, new Date(Date.now() - 3600000).toISOString());
    if (brokerId && !recent) db.insert('notifications', { user_id: brokerId, message: `${contact.first_name} ${contact.last_name || ''} uploaded more documents`.replace(/\s+/g, ' '), link: `#/fact-finds/${row.id}` });
  }
  const f = db.one('SELECT id, doc_key, filename, size, created_at FROM fact_find_files WHERE id = ?', id);
  return f;
}

function publicDeleteFile(row, fileId) {
  if (row.status === 'reviewed') throw new HttpError(400, 'Your broker has already reviewed your documents');
  const ok = db.run('DELETE FROM fact_find_files WHERE id = ? AND fact_find_id = ?', Number(fileId), row.id).changes > 0;
  if (!ok) throw new HttpError(404, 'File not found');
  return { ok };
}

function outstandingDocs(id) {
  const row = load(id);
  const have = new Set(filesOf(id).map((f) => f.doc_key));
  return documentsOf(row).filter((d) => !have.has(d.key));
}

// ---- The broker's side ----------------------------------------------------------------------------------

function list({ status = '', contactId = null } = {}) {
  const where = [];
  const args = [];
  if (status === 'open') where.push("f.status IN ('sent','in_progress')");
  else if (status) { where.push('f.status = ?'); args.push(status); }
  if (contactId) { where.push('f.contact_id = ?'); args.push(Number(contactId)); }
  return db.all(`SELECT f.id, f.contact_id, f.deal_id, f.kind, f.status, f.step, f.sent_to, f.expires_at, f.opened_at, f.last_saved_at, f.submitted_at, f.imported_at, f.created_at, f.answers, f.requests,
      c.first_name, c.last_name, d.title AS deal_title, (SELECT COUNT(*) FROM fact_find_files x WHERE x.fact_find_id = f.id) AS files
    FROM fact_finds f JOIN contacts c ON c.id = f.contact_id LEFT JOIN deals d ON d.id = f.deal_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.id DESC LIMIT 200`, ...args).map((r) => {
    const docs = r.kind === 'documents' ? parse(r.requests, []) : rules.documentsFor(parse(r.answers, null));
    const have = new Set(db.all('SELECT DISTINCT doc_key FROM fact_find_files WHERE fact_find_id = ?', r.id).map((x) => x.doc_key));
    const stepIndex = rules.STEPS.findIndex(([k]) => k === r.step);
    const { answers, requests, ...rest } = r;
    return {
      ...rest, name: [r.first_name, r.last_name].filter(Boolean).join(' '), expired: r.expires_at < nowIso(),
      documents: docs.filter((d) => !d.optional).length, documents_received: docs.filter((d) => !d.optional && have.has(d.key)).length,
      progress: r.kind === 'full' ? (['submitted', 'reviewed'].includes(r.status) ? 100 : stepIndex < 0 ? 0 : Math.round((stepIndex / rules.STEPS.length) * 100)) : null,
    };
  });
}

function get(id) {
  const row = load(id);
  const contact = db.one('SELECT id, first_name, last_name, email FROM contacts WHERE id = ?', row.contact_id);
  const files = filesOf(id);
  const docs = documentsOf(row).map((d) => ({ ...d, files: files.filter((f) => f.doc_key === d.key) }));
  const known = new Set(docs.map((d) => d.key));
  const answers = row.kind === 'full' ? rules.normalise(parse(row.answers, null)) : null;
  return {
    id: row.id, kind: row.kind, status: row.status, contact, deal: row.deal_id ? db.one('SELECT id, title, stage FROM deals WHERE id = ?', row.deal_id) : null,
    link: linkFor(row), reachability: reachability(), sent_to: row.sent_to, message: row.message, expires_at: row.expires_at, expired: row.expires_at < nowIso(),
    opened_at: row.opened_at, last_saved_at: row.last_saved_at, submitted_at: row.submitted_at, imported_at: row.imported_at, reminders: row.reminders, reminded_at: row.reminded_at,
    step: row.step, created_at: row.created_at, import_result: parse(row.import_result, null),
    answers, summary: answers ? rules.summarise(answers) : null,
    documents: docs, other_files: files.filter((f) => !known.has(f.doc_key)),
  };
}

function fileFor(fileId) {
  const f = db.one('SELECT f.*, ff.contact_id FROM fact_find_files f JOIN fact_finds ff ON ff.id = f.fact_find_id WHERE f.id = ?', fileId);
  if (!f) throw new HttpError(404, 'File not found');
  return f;
}

function cancel(id, userId) {
  const row = load(id);
  db.update('fact_finds', id, { status: 'cancelled', updated_at: nowIso() });
  db.insert('activities', { contact_id: row.contact_id, deal_id: row.deal_id, user_id: userId, type: 'system', body: `${row.kind === 'full' ? 'Online fact find' : 'Document request'} cancelled (the link no longer works)` });
  return get(id);
}

function extend(id, days = DEFAULT_DAYS) {
  const row = load(id);
  const d = Math.min(90, Math.max(1, Math.round(Number(days) || DEFAULT_DAYS)));
  db.update('fact_finds', id, { expires_at: `${addDays(today(), d)}T23:59:59.000Z`, status: row.status === 'cancelled' ? (row.submitted_at ? 'submitted' : 'sent') : row.status, updated_at: nowIso() });
  return get(id);
}

// Lets the client make changes again (e.g. after the broker asks for more detail).
function reopen(id) {
  const row = load(id);
  if (row.kind !== 'full') throw new HttpError(400, 'Only fact finds can be reopened');
  const a = rules.normalise(parse(row.answers, null));
  a.declaration = {};
  db.update('fact_finds', id, { status: 'in_progress', answers: JSON.stringify(a), submitted_at: null, updated_at: nowIso() });
  return get(id);
}

function markReviewed(id) {
  load(id);
  db.update('fact_finds', id, { status: 'reviewed', updated_at: nowIso() });
  return get(id);
}

const remove = (id) => db.run('DELETE FROM fact_finds WHERE id = ?', id).changes > 0;

// ---- Importing answers into the CRM ------------------------------------------------------------------

const PURPOSE_TO_DEAL = { buy_home: 'purchase', first_home: 'first_home', buy_investment: 'investment', refinance: 'refinance', build: 'construction', equity: 'top_up', other: 'other' };
const LIABILITY_TO_CRM = { home_loan: 'home_loan', credit_card: 'credit_card', personal: 'personal', car: 'car', business_loan: 'business_loan', hecs: 'hecs', bnpl: 'other', tax: 'other', other: 'other' };
const ASSET_TO_CRM = { savings: 'savings', term_deposit: 'savings', superannuation: 'superannuation', shares: 'shares', vehicle: 'vehicle', contents: 'contents', business: 'business', other: 'other' };
const money = (v) => {
  const n = rules.num(v);
  return n ? Math.round(n * 100) / 100 : null;
};
const setIf = (obj, key, v) => { if (v !== '' && v !== null && v !== undefined) obj[key] = v; };
const firstOfMonth = (v) => (/^\d{4}-\d{2}$/.test(v || '') ? `${v}-01` : /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const RELATIONSHIP = { married: 'spouse', de_facto: 'de_facto' };

function contactFields(p, a) {
  const job = p.jobs?.[0] || {};
  const out = {};
  for (const k of ['first_name', 'last_name', 'email', 'mobile', 'address', 'suburb', 'postcode']) setIf(out, k, cleanText(p[k], 200) || null);
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.dob || '')) out.dob = p.dob;
  if (['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].includes(p.state)) out.state = p.state;
  if (rules.MARITAL.some(([k]) => k === p.marital_status)) out.marital_status = p.marital_status;
  if (job.type) out.employment_type = EMPLOYMENT_TO_CRM[job.type] || 'other';
  setIf(out, 'employer', cleanText(job.type === 'self_employed' ? job.business_name : job.employer, 200) || null);
  const income = Math.round(rules.totalIncome(p));
  if (income) out.annual_income = income;
  if (a.household.dependants !== '' && a.household.dependants !== undefined) out.dependants = rules.dependants(a);
  out.income_details = JSON.stringify(rules.incomeOf(p));
  out.self_employed = JSON.stringify(rules.selfEmployedOf(p));
  out.living_expenses = JSON.stringify(rules.expensesMonthly(a));
  return out;
}

function importToCrm(id, userId) {
  const row = load(id);
  if (row.kind !== 'full') throw new HttpError(400, 'Only fact finds can be imported');
  if (!['submitted', 'reviewed', 'in_progress'].includes(row.status)) throw new HttpError(400, 'The client hasn\'t filled it in yet');
  const a = rules.normalise(parse(row.answers, null));
  const map = parse(row.import_result, null)?.map || { applicants: {}, properties: {}, liabilities: {}, assets: {} };
  const done = [];
  db.transaction(() => {
    const main = db.one('SELECT * FROM contacts WHERE id = ?', row.contact_id);
    const ids = {};
    a.applicants.forEach((p, i) => {
      const fields = contactFields(p, a);
      let cid = i === 0 ? main.id : (map.applicants[p.id] || (p.crm_id && db.one('SELECT id FROM contacts WHERE id = ?', p.crm_id)?.id) || household.partnerOf(main.id)?.id || null);
      if (cid) {
        db.update('contacts', cid, { ...fields, updated_at: nowIso() });
        done.push(`Updated ${fields.first_name || 'contact'}'s details`);
      } else {
        cid = db.insert('contacts', {
          first_name: fields.first_name || 'Partner', ...fields, status: main.status, owner_id: main.owner_id, lead_source: main.lead_source, marketing_opt_in: main.marketing_opt_in,
        });
        done.push(`Added ${fields.first_name || 'the partner'} as a contact`);
      }
      if (i > 0 && !household.household(main.id).some((m) => m.id === cid)) {
        try {
          household.link(main.id, cid, { relationship: RELATIONSHIP[a.applicants[0].marital_status] || 'partner', shared_finances: true });
          done.push('Linked them as a household (shared finances)');
        } catch { /* already related another way */ }
      }
      ids[p.id] = cid;
      map.applicants[p.id] = cid;
    });
    const mainId = main.id;
    const partnerId = a.applicants[1] ? ids[a.applicants[1].id] : null;
    const owners = (owner) => (owner === 'joint' && partnerId ? [mainId, partnerId] : [ids[owner] || mainId, null]);
    const exists = (table, rowId) => rowId && db.one(`SELECT id FROM ${table} WHERE id = ?`, rowId)?.id;

    // Properties and their values.
    const propIds = {};
    let props = 0;
    for (const p of a.properties) {
      if (!cleanText(p.address, 300)) continue;
      const [owner, co] = owners(p.owner);
      const fields = {
        address: cleanText(p.address, 300), usage: ['owner_occupied', 'investment', 'holiday', 'vacant'].includes(p.usage) ? p.usage : 'owner_occupied',
        rental_income_weekly: p.usage === 'investment' && rules.num(p.rent) ? Math.round((rules.toAnnual(p.rent, p.rent_freq || 'weekly') / 52) * 100) / 100 : null,
        contact_id: owner, co_owner_id: co,
      };
      let pid = exists('properties', map.properties[p.id] || p.crm_id);
      if (pid) db.update('properties', pid, { ...fields, updated_at: nowIso() });
      else pid = db.insert('properties', fields);
      props += 1;
      propIds[p.id] = pid;
      map.properties[p.id] = pid;
      const value = money(p.value);
      const current = require('./tracker').summary(mainId).properties.find((x) => x.id === pid)?.current_value;
      const lastEstimate = db.one("SELECT amount FROM valuations WHERE property_id = ? AND method = 'client_estimate' ORDER BY valuation_date DESC, id DESC LIMIT 1", pid)?.amount;
      if (value && Math.round(value) !== Math.round(current || 0) && Math.round(value) !== Math.round(lastEstimate || 0)) {
        db.insert('valuations', { property_id: pid, valuation_date: today(), amount: value, method: 'client_estimate', notes: 'From the client\'s online fact find', created_by: userId });
      }
    }
    if (props) done.push(`${props} propert${props === 1 ? 'y' : 'ies'} saved to the mortgage tracker`);

    // Debts.
    let debts = 0;
    for (const l of a.liabilities) {
      if (!l.type) continue;
      const [owner, co] = owners(l.owner);
      const secured = propIds[l.property];
      const usage = a.properties.find((p) => p.id === l.property)?.usage;
      const freq = ['weekly', 'fortnightly', 'monthly'].includes(l.repayment_freq) ? l.repayment_freq : 'monthly';
      const fields = {
        contact_id: owner, co_borrower_id: co, lender_name: cleanText(l.lender, 120) || rules.labelOf(rules.LIABILITY_TYPES, l.type),
        loan_type: l.type === 'home_loan' && usage === 'investment' ? 'investment_loan' : LIABILITY_TO_CRM[l.type] || 'other',
        limit_amount: money(l.limit), balance: money(l.balance), balance_date: today(), interest_rate: rules.num(l.rate) || null,
        rate_type: l.rate_type === 'fixed' ? 'fixed' : 'variable', fixed_expiry_date: l.rate_type === 'fixed' ? firstOfMonth(l.fixed_expiry) : null,
        repayment_amount: rules.num(l.repayment) ? (['weekly', 'fortnightly', 'monthly'].includes(l.repayment_freq) ? money(l.repayment) : Math.round(rules.toMonthly(l.repayment, l.repayment_freq) * 100) / 100) : null,
        repayment_frequency: freq,
        notes: l.type === 'bnpl' ? 'Buy now, pay later' : l.type === 'tax' ? 'Tax debt' : null,
      };
      let lid = exists('loans', map.liabilities[l.id] || l.crm_id);
      if (lid) {
        db.update('loans', lid, { ...fields, updated_at: nowIso() });
      } else {
        lid = db.insert('loans', { ...fields, arranged_by_us: 0 });
      }
      if (secured) db.run('INSERT OR IGNORE INTO loan_securities (loan_id, property_id) VALUES (?, ?)', lid, secured);
      map.liabilities[l.id] = lid;
      debts += 1;
    }
    if (debts) done.push(`${debts} debt${debts === 1 ? '' : 's'} saved to the mortgage tracker`);

    // Savings, super and other assets.
    let assets = 0;
    for (const s of a.assets) {
      if (!s.type || !money(s.value)) continue;
      const [owner] = owners(s.owner === 'joint' ? a.applicants[0].id : s.owner);
      const fields = {
        contact_id: owner, asset_type: ASSET_TO_CRM[s.type] || 'other', institution: cleanText(s.institution, 120) || null,
        description: rules.labelOf(rules.ASSET_TYPES, s.type), value: money(s.value), value_date: today(),
        notes: s.owner === 'joint' && partnerId ? 'Held jointly' : null,
      };
      let aid = exists('client_assets', map.assets[s.id] || s.crm_id);
      if (aid) db.update('client_assets', aid, { ...fields, updated_at: nowIso() });
      else aid = db.insert('client_assets', fields);
      map.assets[s.id] = aid;
      assets += 1;
    }
    if (assets) done.push(`${assets} asset${assets === 1 ? '' : 's'} saved to the mortgage tracker`);

    // The deal: purpose, property and amounts.
    if (row.deal_id) {
      const g = a.goal;
      const deal = {};
      setIf(deal, 'loan_purpose', PURPOSE_TO_DEAL[g.purpose]);
      setIf(deal, 'property_address', cleanText(g.property_address, 300) || null);
      const value = g.purpose === 'build' ? (money(g.build_price) || 0) + (yes(g.land_owned) ? 0 : money(g.land_price) || 0) : money(g.price);
      setIf(deal, 'property_value', value || null);
      setIf(deal, 'deposit', money(g.deposit));
      setIf(deal, 'loan_amount', money(g.loan_amount));
      if (g.rate_pref && ['variable', 'fixed', 'split'].includes(g.rate_pref)) deal.rate_type = g.rate_pref;
      if (yes(g.interest_only)) deal.repayment_type = 'io';
      if (partnerId) deal.co_borrower_id = partnerId;
      if (Object.keys(deal).length) {
        db.update('deals', row.deal_id, { ...deal, updated_at: nowIso() });
        done.push('Updated the deal (purpose, property and amounts)');
      }
    }

    const notes = [
      a.goal.notes && `Client notes: ${a.goal.notes}`,
      yes(a.goal.changes) && `Expected changes affecting repayments: ${a.goal.changes_details || 'yes (no details)'}`,
      a.goal.retirement_plan && `Retirement plans: ${a.goal.retirement_plan}`,
    ].filter(Boolean);
    db.insert('activities', {
      contact_id: mainId, deal_id: row.deal_id, user_id: userId, type: 'note',
      body: `Online fact find imported into the CRM.\n${done.map((d) => `- ${d}`).join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
    });
    db.update('fact_finds', id, { status: 'reviewed', imported_at: nowIso(), import_result: JSON.stringify({ map, done }), updated_at: nowIso() });
  });
  return { done, fact_find: get(id) };
}
module.exports = {
  KINDS, DOC_LIBRARY: rules.DOC_LIBRARY, MAX_FILE_BYTES, create, sendLink, remind, tick, prefill, byToken, publicView, publicSave, publicSubmit, publicUpload, publicDeleteFile,
  outstandingDocs, list, get, fileFor, cancel, extend, reopen, markReviewed, remove, importToCrm, reachability, linkFor, sniff, documentsOf,
};
