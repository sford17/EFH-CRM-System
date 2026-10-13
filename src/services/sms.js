'use strict';
// SMS via ClickSend (https://www.clicksend.com). Each team member can send from
// their own mobile number once they have verified it in ClickSend ("Own
// Numbers"); replies then go straight to that phone. Without ClickSend set up,
// texts are recorded as "logged" so automations can be tried safely.
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');

const apiBase = () => (process.env.CLICKSEND_API_URL || 'https://rest.clicksend.com/v3').replace(/\/$/, '');
const OPT_OUT = ' Reply STOP to opt out.';

// Australian mobiles in any common format → +614XXXXXXXX. International numbers
// must already start with +.
function normaliseMobile(raw) {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (/^04\d{8}$/.test(s)) return `+61${s.slice(1)}`;
  if (/^614\d{8}$/.test(s)) return `+${s}`;
  if (/^\+614\d{8}$/.test(s)) return s;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  return null;
}

// Alphanumeric sender (business name) or a phone number.
function normaliseSender(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const phone = normaliseMobile(s);
  if (phone) return phone;
  if (/^[A-Za-z0-9 ]{1,11}$/.test(s) && /[A-Za-z]/.test(s)) return s;
  return undefined; // invalid
}

function config() {
  let apiKey = null;
  try {
    apiKey = decrypt(db.getSetting('clicksend_api_key', ''));
  } catch {
    apiKey = null;
  }
  return {
    username: db.getSetting('clicksend_username', '') || '',
    apiKey,
    defaultFrom: db.getSetting('sms_default_from', '') || '',
  };
}

const isConfigured = () => {
  const c = config();
  return Boolean(c.username && c.apiKey);
};

function saveConfig({ username, api_key, default_from }) {
  if (username !== undefined) db.setSetting('clicksend_username', String(username || '').trim());
  if (api_key) db.setSetting('clicksend_api_key', encrypt(String(api_key).trim()));
  if (default_from !== undefined) {
    const from = normaliseSender(default_from);
    if (from === undefined) throw new HttpError(400, 'Default sender must be a mobile number or a business name of up to 11 letters/numbers');
    db.setSetting('sms_default_from', from || '');
  }
}

// Segments as the recipient's phone will count them.
function segments(text) {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const len = text.length;
  if (gsm) return len <= 160 ? 1 : Math.ceil(len / 153);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

function queueSms({ to, body, contactId = null, dealId = null, partnerId = null, templateId = null, automationId = null, senderUserId = null, sendAfter = null }) {
  return db.insert('sms_messages', {
    to_number: to,
    body,
    contact_id: contactId,
    partner_id: partnerId,
    deal_id: dealId,
    template_id: templateId,
    automation_id: automationId,
    sender_user_id: senderUserId,
    send_after: sendAfter || nowIso(),
  });
}

// Queues a text to a contact's mobile, applying opt-out rules. Marketing texts
// (birthdays, reviews, rate offers) need marketing consent and carry an opt-out
// line, as the Spam Act requires. Returns { id } or { id: null, reason }.
function queueForContact({ contactId, dealId = null, body, marketing = false, templateId = null, automationId = null, senderUserId = null, sendAfter = null }) {
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!contact) return { id: null, reason: 'Contact not found' };
  const to = normaliseMobile(contact.mobile);
  if (!to) return { id: null, reason: contact.mobile ? `"${contact.mobile}" is not a valid mobile number` : 'Contact has no mobile number' };
  if (contact.sms_opt_out) return { id: null, reason: 'Contact has opted out of SMS' };
  if (marketing && !contact.marketing_opt_in) return { id: null, reason: 'Contact has opted out of marketing' };
  const text = String(body || '').trim();
  if (!text) return { id: null, reason: 'Message is empty' };
  const id = queueSms({
    to,
    body: marketing && !/STOP/.test(text) ? `${text}${OPT_OUT}` : text,
    contactId,
    dealId,
    templateId,
    automationId,
    senderUserId: senderUserId || contact.owner_id,
    sendAfter,
  });
  return { id, reason: null };
}

// Queues a text to a referral partner (e.g. "your client has settled"). It's
// noted on the client's timeline via the deal, but isn't one of the client's
// own texts. Partners with SMS updates switched off are skipped.
function queueForPartner({ partnerId, dealId = null, body, automationId = null, senderUserId = null, sendAfter = null }) {
  const partner = partnerId ? db.one('SELECT * FROM referral_partners WHERE id = ?', partnerId) : null;
  if (!partner) return { id: null, reason: 'No referral partner' };
  if (!partner.active) return { id: null, reason: `${partner.name} is marked inactive` };
  if (!partner.sms_updates) return { id: null, reason: `${partner.name} has text updates switched off` };
  const raw = partner.mobile || partner.phone;
  const to = normaliseMobile(raw);
  if (!to) return { id: null, reason: raw ? `${partner.name}'s number "${raw}" is not a mobile` : `${partner.name} has no mobile number` };
  const text = String(body || '').trim();
  if (!text) return { id: null, reason: 'Message is empty' };
  const id = queueSms({ to, body: text, dealId, partnerId: partner.id, automationId, senderUserId, sendAfter });
  return { id, reason: null };
}

function senderFor(msg) {
  let userId = msg.sender_user_id;
  if (!userId && msg.deal_id) userId = db.one('SELECT owner_id FROM deals WHERE id = ?', msg.deal_id)?.owner_id;
  const own = userId ? db.one('SELECT sms_from FROM users WHERE id = ?', userId)?.sms_from : null;
  return own || config().defaultFrom || null;
}

async function clicksendSend({ to, from, body, ref }) {
  const c = config();
  const res = await fetch(`${apiBase()}/sms/send`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.username}:${c.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ source: 'efh-crm', to, body, ...(from ? { from } : {}), custom_string: ref }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.response_code !== 'SUCCESS') {
    throw new Error(`ClickSend: ${data.response_msg || `request failed (${res.status})`}`);
  }
  const m = data.data?.messages?.[0];
  if (!m || m.status !== 'SUCCESS') throw new Error(`ClickSend: ${(m?.status || 'message rejected').replace(/_/g, ' ').toLowerCase()}`);
  // What ClickSend charged (for Reports → Running costs), when it says.
  const price = Number(m.message_price);
  return {
    id: m.message_id, parts: Number(m.message_parts) || null,
    price: m.message_price !== undefined && m.message_price !== null && Number.isFinite(price) ? price : null,
    currency: data.data?.currency?.currency_name_short || null,
  };
}

function logActivity(msg, text) {
  if (msg.partner_id) {
    // On the referred client's timeline: "SMS to referral partner Alex Morgan (Harbourside Realty) sent from …: …"
    const deal = msg.deal_id ? db.one('SELECT contact_id FROM deals WHERE id = ?', msg.deal_id) : null;
    const p = db.one('SELECT name, company FROM referral_partners WHERE id = ?', msg.partner_id);
    if (!deal || !p) return;
    const to = ` to referral partner ${p.name}${p.company ? ` (${p.company})` : ''}`;
    db.insert('activities', { contact_id: deal.contact_id, deal_id: msg.deal_id, user_id: msg.sender_user_id, type: 'sms', body: `${text.replace(/^SMS /, `SMS${to} `)}: ${msg.body}` });
    return;
  }
  if (!msg.contact_id) return;
  db.insert('activities', { contact_id: msg.contact_id, deal_id: msg.deal_id, user_id: msg.sender_user_id, type: 'sms', body: `${text}: ${msg.body}` });
}

async function processDue() {
  const due = db.all("SELECT * FROM sms_messages WHERE status = 'queued' AND send_after <= ? ORDER BY id LIMIT 100", nowIso());
  const live = isConfigured();
  for (const msg of due) {
    const from = senderFor(msg);
    try {
      if (live) {
        const r = await clicksendSend({ to: msg.to_number, from, body: msg.body, ref: `sms-${msg.id}` });
        db.update('sms_messages', msg.id, {
          status: 'sent', from_number: from, provider_id: r.id, sent_at: nowIso(), error: null, parts: r.parts || segments(msg.body), price: r.price, currency: r.currency,
        });
        logActivity(msg, `SMS sent${from ? ` from ${from}` : ''}`);
      } else {
        db.update('sms_messages', msg.id, { status: 'logged', from_number: from, sent_at: nowIso(), error: null });
        logActivity(msg, 'SMS logged (ClickSend not connected)');
      }
      if (msg.contact_id && live) {
        db.run('UPDATE contacts SET last_contacted_at = ? WHERE id = ?', nowIso(), msg.contact_id);
      }
    } catch (err) {
      db.update('sms_messages', msg.id, { status: 'failed', from_number: from, error: String(err.message || err) });
    }
  }
  return due.length;
}

// Serialised so overlapping runs can't send the same text twice.
let chain = Promise.resolve();
function processSms() {
  const run = chain.then(processDue, processDue);
  chain = run.catch(() => {});
  return run;
}

// Sends soon without making the caller wait (used by automations).
function processSoon() {
  setImmediate(() => processSms().catch((err) => console.error('[sms]', err)));
}

module.exports = {
  queueForPartner,
  normaliseMobile, normaliseSender, config, isConfigured, saveConfig, segments,
  queueSms, queueForContact, processSms, processSoon, OPT_OUT,
};
