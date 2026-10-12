'use strict';
// Outlook / Microsoft 365 mailbox integration via Microsoft Graph.
//
// Each CRM user connects their own mailbox (OAuth 2.0 authorization code flow
// with PKCE). The CRM then:
//   - sends email through that mailbox (it lands in the user's Sent Items);
//   - periodically pulls Inbox and Sent Items and stores any message to or
//     from a known contact, logging it on the contact's timeline;
//   - replies to stored messages in the same Outlook conversation.
// Messages with people who are not contacts are never stored.
const crypto = require('node:crypto');
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');

const SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send';
const MESSAGE_FIELDS = 'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink';
const MAX_BODY = 100000;

const loginBase = () => (process.env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
const graphBase = () => (process.env.GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const syncDays = () => Number(process.env.MAIL_SYNC_DAYS || 30);
const graphTime = (iso) => iso.replace(/\.\d{3}Z$/, 'Z');
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// ---- App registration settings ---------------------------------------------

function appConfig() {
  let clientSecret = null;
  try {
    clientSecret = decrypt(db.getSetting('outlook_client_secret', ''));
  } catch {
    clientSecret = null; // encryption key changed; secret must be re-entered
  }
  return {
    clientId: db.getSetting('outlook_client_id', '') || '',
    tenant: db.getSetting('outlook_tenant', '') || 'common',
    clientSecret,
  };
}

function isConfigured() {
  const c = appConfig();
  return Boolean(c.clientId && c.clientSecret);
}

function saveAppConfig({ client_id, client_secret, tenant }) {
  if (client_id !== undefined) db.setSetting('outlook_client_id', String(client_id || '').trim());
  if (tenant !== undefined) {
    const t = String(tenant || '').trim();
    if (t && !/^[A-Za-z0-9.-]+$/.test(t)) throw new HttpError(400, 'Directory (tenant) ID looks wrong – paste it exactly as shown in Microsoft Entra');
    db.setSetting('outlook_tenant', t);
  }
  if (client_secret) db.setSetting('outlook_client_secret', encrypt(String(client_secret).trim()));
}

// ---- OAuth -----------------------------------------------------------------

function startConnect(userId, redirectUri) {
  const cfg = appConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new HttpError(400, 'Outlook has not been set up yet. An admin needs to enter the Microsoft app details in Settings first.');
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
  db.insert('oauth_states', {
    state, user_id: userId, verifier, redirect_uri: redirectUri,
    expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
  });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${loginBase()}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize?${params}`;
}

async function tokenRequest(params) {
  const cfg = appConfig();
  const res = await fetch(`${loginBase()}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: SCOPES, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description?.split('\r\n')[0] || data.error || `Microsoft sign-in failed (${res.status})`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function saveTokens(accountId, tokens) {
  const patch = {
    access_token: encrypt(tokens.access_token),
    token_expires_at: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString(),
  };
  if (tokens.refresh_token) patch.refresh_token = encrypt(tokens.refresh_token);
  db.update('mail_accounts', accountId, patch);
}

async function finishConnect({ code, state }) {
  const row = state ? db.one('SELECT * FROM oauth_states WHERE state = ?', state) : null;
  if (!row || row.expires_at < nowIso()) throw new Error('This sign-in link has expired. Please go back to Settings and click "Connect Outlook" again.');
  db.run('DELETE FROM oauth_states WHERE state = ?', state);
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, code_verifier: row.verifier });
  const me = await rawGraph(tokens.access_token, 'GET', '/me?$select=displayName,mail,userPrincipalName');
  const email = (me.mail || me.userPrincipalName || '').toLowerCase();

  const existing = db.one('SELECT * FROM mail_accounts WHERE user_id = ?', row.user_id);
  const fields = { email, display_name: me.displayName || null, connected: 1, sync_error: null, connected_at: nowIso() };
  // A different mailbox starts its history from scratch.
  if (existing && existing.email !== email) fields.last_sync_at = null;
  const id = existing ? (db.update('mail_accounts', existing.id, fields), existing.id) : db.insert('mail_accounts', { user_id: row.user_id, ...fields });
  saveTokens(id, tokens);
  return { userId: row.user_id, email };
}

function accountForUser(userId) {
  return db.one('SELECT * FROM mail_accounts WHERE user_id = ? AND connected = 1', userId) || null;
}

function disconnect(userId) {
  db.run(
    'UPDATE mail_accounts SET connected = 0, access_token = NULL, refresh_token = NULL, token_expires_at = NULL WHERE user_id = ?',
    userId,
  );
}

async function accessToken(accountId, forceRefresh = false) {
  const account = db.one('SELECT * FROM mail_accounts WHERE id = ?', accountId);
  if (!account || !account.connected) throw new Error('Outlook is not connected');
  if (!forceRefresh && account.access_token && account.token_expires_at > new Date(Date.now() + 120000).toISOString()) {
    return decrypt(account.access_token);
  }
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(account.refresh_token) });
    saveTokens(account.id, tokens);
    return tokens.access_token;
  } catch (err) {
    if (err.code === 'invalid_grant') {
      db.update('mail_accounts', account.id, { connected: 0, sync_error: 'Outlook connection expired – please reconnect in Settings' });
      throw new Error('Outlook connection expired – please reconnect in Settings');
    }
    throw err;
  }
}

// ---- Graph requests --------------------------------------------------------

async function rawGraph(token, method, pathOrUrl, body, { html = false } = {}) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${graphBase()}${pathOrUrl}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      // Immutable ids survive a message moving from Drafts to Sent Items.
      Prefer: `IdType="ImmutableId", outlook.body-content-type="${html ? 'html' : 'text'}"`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(`Outlook: ${data.error?.message || `request failed (${res.status})`}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function graph(accountId, method, pathOrUrl, body, opts) {
  try {
    return await rawGraph(await accessToken(accountId), method, pathOrUrl, body, opts);
  } catch (err) {
    if (err.status !== 401) throw err;
    return rawGraph(await accessToken(accountId, true), method, pathOrUrl, body, opts);
  }
}

const graphAttachment = (a) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: a.filename,
  contentType: a.mime,
  contentBytes: a.data.toString('base64'),
  isInline: true,
  contentId: a.cid,
});

// ---- Storing messages ------------------------------------------------------

const lower = (s) => String(s || '').trim().toLowerCase();
const address = (r) => lower(r?.emailAddress?.address);

function normalise(m, direction) {
  return {
    graphId: m.id,
    conversationId: m.conversationId || null,
    direction,
    fromEmail: address(m.from),
    fromName: m.from?.emailAddress?.name || null,
    to: (m.toRecipients || []).map(address).filter(Boolean),
    cc: (m.ccRecipients || []).map(address).filter(Boolean),
    subject: m.subject || '(no subject)',
    body: m.body?.content || '',
    preview: m.bodyPreview || null,
    hasAttachments: Boolean(m.hasAttachments),
    webLink: /^https:\/\//.test(m.webLink || '') ? m.webLink : null,
    sentAt: (direction === 'in' ? m.receivedDateTime : m.sentDateTime || m.receivedDateTime) || nowIso(),
  };
}

// Saves a message if it involves at least one contact. Returns
// { id, contactIds, dealId } or null when skipped / already stored.
function recordEmail(account, msg, { contactIds: extraIds = [], dealId = null } = {}) {
  if (db.one('SELECT 1 FROM emails WHERE account_id = ? AND graph_id = ?', account.id, msg.graphId)) return null;
  const addresses = [...new Set(msg.direction === 'in' ? [msg.fromEmail] : [...msg.to, ...msg.cc])].filter(Boolean);
  const matched = addresses.length
    ? db.all(`SELECT id FROM contacts WHERE lower(email) IN (${addresses.map(() => '?').join(',')})`, ...addresses).map((r) => r.id)
    : [];
  const contactIds = [...new Set([...extraIds.filter(Boolean), ...matched])];
  if (!contactIds.length) return null;

  if (!dealId && contactIds.length === 1) {
    const open = db.all("SELECT id FROM deals WHERE (contact_id = ? OR co_borrower_id = ?) AND stage NOT IN ('settled','lost')", contactIds[0], contactIds[0]);
    if (open.length === 1) dealId = open[0].id;
  }
  const body = String(msg.body || '').slice(0, MAX_BODY);
  return db.transaction(() => {
    const id = db.insert('emails', {
      account_id: account.id,
      graph_id: msg.graphId,
      conversation_id: msg.conversationId,
      direction: msg.direction,
      from_email: msg.fromEmail,
      from_name: msg.fromName,
      to_emails: msg.to.join(','),
      cc_emails: msg.cc.join(','),
      subject: msg.subject,
      body_text: body,
      preview: (msg.preview || body).replace(/\s+/g, ' ').trim().slice(0, 255),
      has_attachments: msg.hasAttachments ? 1 : 0,
      web_link: msg.webLink,
      deal_id: dealId,
      sent_at: msg.sentAt,
    });
    for (const contactId of contactIds) {
      db.run('INSERT OR IGNORE INTO email_contacts (email_id, contact_id) VALUES (?, ?)', id, contactId);
      db.insert('activities', {
        contact_id: contactId,
        deal_id: dealId,
        user_id: account.user_id,
        type: 'email',
        email_id: id,
        body: `${msg.direction === 'in' ? 'Email received' : 'Email sent'}: ${msg.subject}`,
        created_at: msg.sentAt,
      });
      if (msg.direction === 'out') {
        db.run('UPDATE contacts SET last_contacted_at = ? WHERE id = ? AND (last_contacted_at IS NULL OR last_contacted_at < ?)', msg.sentAt, contactId, msg.sentAt);
      }
    }
    return { id, contactIds, dealId };
  });
}

function onInbound(account, msg, saved) {
  const contact = db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', saved.contactIds[0]);
  const who = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : msg.fromName || msg.fromEmail;
  db.insert('notifications', { user_id: account.user_id, message: `Email from ${who}: ${msg.subject}`, link: `#/contacts/${saved.contactIds[0]}` });
  const automation = require('./automation'); // loaded lazily: automation → mailer → outlook
  for (const contactId of saved.contactIds) {
    automation.emit('email.received', { contactId, dealId: saved.dealId, subject: msg.subject, from_email: msg.fromEmail });
  }
}

// ---- Sending & replying ----------------------------------------------------

// `email` is the output of emailHtml.buildEmail (html + inline images).
async function sendMail(account, { to, subject, email }) {
  const recipients = String(to).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const draft = await graph(account.id, 'POST', '/me/messages', {
    subject,
    body: { contentType: 'HTML', content: email.html },
    toRecipients: recipients.map((a) => ({ emailAddress: { address: a } })),
    attachments: email.attachments.map(graphAttachment),
  });
  await graph(account.id, 'POST', `/me/messages/${encodeURIComponent(draft.id)}/send`);
  return {
    graphId: draft.id,
    conversationId: draft.conversationId || null,
    webLink: draft.webLink || null,
    to: recipients.map(lower),
  };
}

async function reply(emailId, userId, body) {
  const email = db.one('SELECT e.*, a.user_id, a.connected FROM emails e JOIN mail_accounts a ON a.id = e.account_id WHERE e.id = ?', emailId);
  if (!email) throw new HttpError(404, 'Email not found');
  if (email.user_id !== userId) throw new HttpError(403, 'This email is in another team member\'s mailbox, so only they can reply to it');
  if (!email.connected) throw new HttpError(400, 'Your Outlook is not connected. Reconnect it in Settings.');
  if (!String(body || '').trim()) throw new HttpError(400, 'Write a reply first');
  // createReply gives a draft with the quoted thread; our message and the
  // sender's signature go above it.
  const { buildEmail } = require('./emailHtml');
  const built = buildEmail({ body: String(body), senderUserId: userId, reply: true });
  const draft = await graph(email.account_id, 'POST', `/me/messages/${encodeURIComponent(email.graph_id)}/createReply`, {}, { html: true });
  const quoted = draft.body?.content || '';
  const content = /<body[^>]*>/i.test(quoted) ? quoted.replace(/<body[^>]*>/i, (tag) => `${tag}${built.html}<br>`) : `${built.html}<br>${quoted}`;
  const draftPath = `/me/messages/${encodeURIComponent(draft.id)}`;
  await graph(email.account_id, 'PATCH', draftPath, { body: { contentType: 'HTML', content } }, { html: true });
  for (const a of built.attachments) await graph(email.account_id, 'POST', `${draftPath}/attachments`, graphAttachment(a));
  await graph(email.account_id, 'POST', `${draftPath}/send`);
  // The sent reply is picked up from Sent Items by the next sync; nudge one soon.
  setTimeout(() => syncAccount(email.account_id).catch(() => {}), 5000).unref();
  return { ok: true };
}

// ---- Sync ------------------------------------------------------------------

const syncing = new Map();

function syncAccount(accountId) {
  if (!syncing.has(accountId)) {
    syncing.set(accountId, runSync(accountId).finally(() => syncing.delete(accountId)));
  }
  return syncing.get(accountId);
}

async function runSync(accountId) {
  const account = db.one('SELECT * FROM mail_accounts WHERE id = ?', accountId);
  if (!account || !account.connected) return { imported: 0 };
  const initial = !account.last_sync_at;
  const since = graphTime(initial
    ? new Date(Date.now() - syncDays() * 86400000).toISOString()
    : new Date(Date.parse(account.last_sync_at) - 10 * 60000).toISOString());
  const started = nowIso();
  let imported = 0;
  try {
    for (const [folder, field, direction] of [['inbox', 'receivedDateTime', 'in'], ['sentitems', 'sentDateTime', 'out']]) {
      const query = { $filter: `${field} ge ${since}`, $orderby: `${field} asc`, $top: '50', $select: MESSAGE_FIELDS };
      let url = `/me/mailFolders/${folder}/messages?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
      for (let page = 0; url && page < 40; page++) {
        const data = await graph(account.id, 'GET', url);
        for (const m of data?.value || []) {
          const msg = normalise(m, direction);
          if (direction === 'in' && msg.fromEmail === lower(account.email)) continue;
          const saved = recordEmail(account, msg);
          if (!saved) continue;
          imported++;
          if (direction === 'in' && !initial) onInbound(account, msg, saved);
        }
        const next = data?.['@odata.nextLink'];
        url = next && next.startsWith(graphBase()) ? next : null;
      }
    }
    db.update('mail_accounts', account.id, { last_sync_at: started, sync_error: null });
  } catch (err) {
    db.update('mail_accounts', account.id, { sync_error: err.message });
    throw err;
  }
  return { imported, initial };
}

async function syncAll(log = console) {
  if (!isConfigured()) return 0;
  let total = 0;
  for (const { id, email } of db.all('SELECT id, email FROM mail_accounts WHERE connected = 1')) {
    try {
      total += (await syncAccount(id)).imported;
    } catch (err) {
      log.error(`[outlook] sync failed for ${email}: ${err.message}`);
    }
  }
  return total;
}

function publicAccount(row) {
  if (!row) return null;
  return {
    email: row.email,
    display_name: row.display_name,
    connected: Boolean(row.connected),
    last_sync_at: row.last_sync_at,
    sync_error: row.sync_error,
    connected_at: row.connected_at,
  };
}

module.exports = {
  appConfig, isConfigured, saveAppConfig, startConnect, finishConnect, accountForUser, disconnect,
  sendMail, reply, recordEmail, syncAccount, syncAll, publicAccount, normalise,
};
