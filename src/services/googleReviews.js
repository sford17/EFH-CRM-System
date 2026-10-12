'use strict';
// Asking clients for a Google review, by email and/or SMS, automatically after
// settlement or one-off from a contact.
const db = require('../db');
const { render, buildContext } = require('./templating');
const { HttpError, nowIso, daysBetween, today } = require('../util');

const LINK_FIELD = /\{\{\s*business\.google_review_link\s*\}\}/;
const reviewLink = () => db.getSetting('google_review_link', '');
const usesLink = (...texts) => texts.some((t) => LINK_FIELD.test(String(t || '')));

// A message that relies on the review link can't go out until it's set.
function linkMissing(...texts) {
  return usesLink(...texts) && !reviewLink();
}

function markRequested(contactId) {
  if (contactId) db.run('UPDATE contacts SET review_requested_at = ? WHERE id = ?', nowIso(), contactId);
}

const template = () => db.one("SELECT * FROM email_templates WHERE name = 'Review request'");

// What a one-off request would send, filled in for this client.
function draft(contactId, userId) {
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!contact) throw new HttpError(404, 'Contact not found');
  const t = template();
  const ctx = buildContext({ contactId, userId });
  const sms = require('./sms');
  const emailBlocked = !contact.email ? 'No email address on file'
    : !contact.marketing_opt_in ? `${contact.first_name} has opted out of marketing emails and texts` : null;
  const smsBlocked = !sms.normaliseMobile(contact.mobile) ? 'No mobile number on file'
    : contact.sms_opt_out ? `${contact.first_name} has opted out of SMS`
      : !contact.marketing_opt_in ? `${contact.first_name} has opted out of marketing emails and texts` : null;
  return {
    link: reviewLink(),
    template_found: Boolean(t),
    subject: t ? render(t.subject, ctx) : `How did we do, ${contact.first_name}?`,
    body: t ? render(t.body, ctx) : '',
    sms: t?.sms_body ? render(t.sms_body, ctx) : '',
    email_to: contact.email,
    mobile: contact.mobile,
    email_blocked: emailBlocked,
    sms_blocked: smsBlocked,
    review_requested_at: contact.review_requested_at,
    google_reviewed_at: contact.google_reviewed_at,
    days_since_asked: contact.review_requested_at ? daysBetween(today(new Date(contact.review_requested_at)), today()) : null,
  };
}

// Sends a one-off request. `email` = { subject, body } and/or `sms` = { body }.
async function send(contactId, { email, sms: text, dealId = null } = {}, userId) {
  const d = draft(contactId, userId);
  if (!email && !text) throw new HttpError(400, 'Choose email, SMS or both');
  if (!d.link) throw new HttpError(400, 'Add your Google review link in Settings → Business first');
  const contact = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
  if (dealId && !db.one('SELECT 1 FROM deals WHERE id = ? AND (contact_id = ? OR co_borrower_id = ?)', dealId, contactId, contactId)) {
    throw new HttpError(400, 'That deal belongs to a different client');
  }
  if (email && d.email_blocked) throw new HttpError(400, d.email_blocked);
  if (text && d.sms_blocked) throw new HttpError(400, d.sms_blocked);
  const sent = [];
  const mailer = require('./mailer');
  const sms = require('./sms');
  if (email) {
    if (!String(email.subject || '').trim() || !String(email.body || '').trim()) throw new HttpError(400, 'The email needs a subject and a message');
    mailer.queueEmail({
      to: contact.email, subject: email.subject, body: email.body, contactId, dealId, templateId: template()?.id ?? null, senderUserId: userId,
    });
    sent.push('email');
  }
  if (text) {
    const r = sms.queueForContact({ contactId, dealId, body: String(text.body || ''), marketing: true, templateId: template()?.id ?? null, senderUserId: userId });
    if (!r.id) throw new HttpError(400, r.reason);
    sent.push('SMS');
  }
  markRequested(contactId);
  db.insert('activities', { contact_id: contactId, deal_id: dealId, user_id: userId, type: 'system', body: `Google review requested by ${sent.join(' and ')}` });
  await mailer.processOutbox();
  await sms.processSms();
  return { sent, review_requested_at: db.one('SELECT review_requested_at FROM contacts WHERE id = ?', contactId).review_requested_at };
}

// "They've left a review" (or undo). Clients marked as reviewed aren't asked again automatically.
function markReviewed(contactId, reviewed, userId) {
  const contact = db.one('SELECT id FROM contacts WHERE id = ?', contactId);
  if (!contact) throw new HttpError(404, 'Contact not found');
  const at = reviewed ? today() : null;
  db.run('UPDATE contacts SET google_reviewed_at = ? WHERE id = ?', at, contactId);
  if (reviewed) db.insert('activities', { contact_id: contactId, user_id: userId, type: 'system', body: 'Left a Google review' });
  return { google_reviewed_at: at };
}

module.exports = { reviewLink, usesLink, linkMissing, markRequested, draft, send, markReviewed };
