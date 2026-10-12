'use strict';
const db = require('../db');
const { render, buildContext } = require('./templating');
const outlook = require('./outlook');
const sms = require('./sms');
const { buildEmail } = require('./emailHtml');
const { nowIso } = require('../util');

let transport;
function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) {
    const nodemailer = require('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

function queueEmail({ to, subject, body, contactId = null, dealId = null, templateId = null, automationId = null, sendAfter = null, senderUserId = null }) {
  if (!to) throw new Error('Recipient has no email address');
  return db.insert('outbox', {
    sender_user_id: senderUserId,
    to_email: to,
    subject,
    body,
    contact_id: contactId,
    deal_id: dealId,
    template_id: templateId,
    automation_id: automationId,
    send_after: sendAfter || nowIso(),
  });
}

// Renders a template against a contact/deal and queues it. Returns the outbox id,
// or null with a reason when the email should not go out.
function queueTemplate(templateId, { contactId, dealId, loanId, automationId, sendAfter, to, userId } = {}) {
  const template = db.one('SELECT * FROM email_templates WHERE id = ?', templateId);
  if (!template) return { id: null, reason: `Template ${templateId} not found` };
  const ctx = buildContext({ contactId, dealId, loanId, userId, latestDeal: true });
  const recipient = to || ctx.contact?.email;
  if (!recipient) return { id: null, reason: 'Contact has no email address' };
  if (template.category === 'marketing' && ctx.contact && !ctx.contact.marketing_opt_in) {
    return { id: null, reason: 'Contact has opted out of marketing' };
  }
  const id = queueEmail({
    to: recipient,
    subject: render(template.subject, ctx),
    body: render(template.body, ctx),
    contactId: ctx.contact?.id ?? null,
    dealId: ctx.deal?.id ?? null,
    templateId,
    automationId,
    sendAfter,
    senderUserId: userId || ctx.broker?.id || null,
  });
  // Templates can carry a companion text that goes out with the email.
  let smsId = null;
  if (template.sms_body && ctx.contact) {
    const r = sms.queueForContact({
      contactId: ctx.contact.id,
      dealId: ctx.deal?.id ?? null,
      body: render(template.sms_body, ctx),
      marketing: ['marketing', 'retention'].includes(template.category),
      templateId,
      automationId,
      senderUserId: userId || ctx.broker?.id || null,
      sendAfter,
    });
    smsId = r.id;
    if (smsId && !sendAfter) sms.processSoon();
  }
  return { id, reason: null, smsId };
}

// The team member an email goes out as: whoever queued it, otherwise the
// owner of the deal or contact.
function senderFor(mail) {
  if (mail.sender_user_id) return mail.sender_user_id;
  const dealOwner = mail.deal_id ? db.one('SELECT owner_id FROM deals WHERE id = ?', mail.deal_id)?.owner_id : null;
  if (dealOwner) return dealOwner;
  return mail.contact_id ? db.one('SELECT owner_id FROM contacts WHERE id = ?', mail.contact_id)?.owner_id ?? null : null;
}

function logActivity(mail, text) {
  if (!mail.contact_id) return;
  db.insert('activities', { contact_id: mail.contact_id, deal_id: mail.deal_id, type: 'email', body: `${text}: ${mail.subject}` });
}

// Sends everything due in the outbox, in order of preference: through the
// sender's connected Outlook mailbox, through SMTP, or (with neither set up)
// marked "logged" so the workflow can be exercised without sending anything.
async function processDue() {
  const due = db.all("SELECT * FROM outbox WHERE status = 'queued' AND send_after <= ? ORDER BY id LIMIT 50", nowIso());
  const t = getTransport();
  const from = process.env.SMTP_FROM || db.getSetting('business_email') || 'crm@localhost';
  for (const mail of due) {
    try {
      const senderId = senderFor(mail);
      const account = senderId ? outlook.accountForUser(senderId) : null;
      const email = buildEmail({ body: mail.body, senderUserId: senderId });
      if (account) {
        const sent = await outlook.sendMail(account, { to: mail.to_email, subject: mail.subject, email });
        db.update('outbox', mail.id, { status: 'sent', sent_via: 'outlook', sent_at: nowIso(), error: null });
        outlook.recordEmail(account, {
          graphId: sent.graphId, conversationId: sent.conversationId, direction: 'out',
          fromEmail: account.email, fromName: account.display_name, to: sent.to, cc: [],
          subject: mail.subject, body: mail.body, preview: null, hasAttachments: false, webLink: sent.webLink, sentAt: nowIso(),
        }, { contactIds: [mail.contact_id], dealId: mail.deal_id });
      } else if (t) {
        await t.sendMail({
          from, to: mail.to_email, subject: mail.subject, text: email.text, html: email.html,
          attachments: email.attachments.map((a) => ({ filename: a.filename, content: a.data, contentType: a.mime, cid: a.cid })),
        });
        db.update('outbox', mail.id, { status: 'sent', sent_via: 'smtp', sent_at: nowIso(), error: null });
        logActivity(mail, 'Email sent');
      } else {
        db.update('outbox', mail.id, { status: 'logged', sent_at: nowIso(), error: null });
        logActivity(mail, 'Email logged (no Outlook or SMTP connected)');
      }
    } catch (err) {
      db.update('outbox', mail.id, { status: 'failed', error: String(err.message || err) });
    }
  }
  return due.length;
}

// Runs are serialised so the scheduler and a manual send can't both pick up
// (and double-send) the same queued email.
let chain = Promise.resolve();
function processOutbox() {
  const run = chain.then(processDue, processDue);
  chain = run.catch(() => {});
  return run;
}

module.exports = { queueEmail, queueTemplate, processOutbox };
