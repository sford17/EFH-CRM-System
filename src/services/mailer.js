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

function queueEmail({ to, subject, body, contactId = null, dealId = null, loanId = null, lenderId = null, internal = false, templateId = null, automationId = null, sendAfter = null, senderUserId = null, attachments = null }) {
  if (!to) throw new Error('Recipient has no email address');
  return db.insert('outbox', {
    sender_user_id: senderUserId,
    attachments: attachments?.length ? JSON.stringify(attachments.map((a) => ({ filename: a.filename, mime: a.mime, data: Buffer.from(a.data).toString('base64') }))) : null,
    to_email: to,
    subject,
    body,
    contact_id: contactId,
    deal_id: dealId,
    loan_id: loanId,
    lender_id: lenderId,
    internal: internal ? 1 : 0,
    template_id: templateId,
    automation_id: automationId,
    send_after: sendAfter || nowIso(),
  });
}

// Renders a template against a contact/deal and queues it. Returns the outbox id,
// or null with a reason when the email should not go out.
function queueTemplate(templateId, { contactId, dealId, loanId, automationId, sendAfter, to, userId, addresseeIds, recipientRole } = {}) {
  const template = db.one('SELECT * FROM email_templates WHERE id = ?', templateId);
  if (!template) return { id: null, reason: `Template ${templateId} not found` };
  const ctx = buildContext({ contactId, dealId, loanId, userId, latestDeal: true, addresseeIds, recipientRole });
  // Going to the agent/solicitor etc. on the deal rather than the client.
  if (recipientRole && !require('./parties').isRole(recipientRole)) return { id: null, reason: 'Unknown recipient' };
  if (recipientRole) {
    if (!ctx.recipient.id) return { id: null, reason: `No ${require('./parties').ROLES[recipientRole].label.toLowerCase()} on this deal` };
    if (!ctx.recipient.email) return { id: null, reason: `${ctx.recipient.name} has no email address` };
    to = ctx.recipient.email;
  }
  const recipient = to || [...new Set(ctx.addressees.map((c) => c.email).filter(Boolean))].join(', ');
  if (!recipient) return { id: null, reason: 'Contact has no email address' };
  if (template.category === 'marketing' && ctx.contact && !ctx.contact.marketing_opt_in) {
    return { id: null, reason: 'Contact has opted out of marketing' };
  }
  const reviews = require('./googleReviews');
  if (reviews.linkMissing(template.subject, template.body)) return { id: null, reason: 'Add your Google review link in Settings → Business' };
  const id = queueEmail({
    to: recipient,
    subject: render(template.subject, ctx),
    body: render(template.body, ctx),
    contactId: ctx.contact?.id ?? null,
    dealId: ctx.deal?.id ?? null,
    loanId: ctx.loan?.id ?? null, // so a fixed-rate chart shows the loan the email is about
    templateId,
    automationId,
    sendAfter,
    senderUserId: userId || ctx.broker?.id || null,
  });
  // Remember when the client was last asked for a Google review.
  if (ctx.contact && !to && reviews.usesLink(template.body, template.sms_body)) reviews.markRequested(ctx.contact.id);
  // Templates can carry a companion text that goes out with the email
  // (to the client, so not when the email is for someone else).
  let smsId = null;
  if (template.sms_body && ctx.contact && !to && !reviews.linkMissing(template.sms_body)) {
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
  const lender = mail.lender_id ? require('./lenders').describeRecipient(mail.lender_id, String(mail.to_email).split(/[;,]/)[0].trim()) : null;
  db.insert('activities', { contact_id: mail.contact_id, deal_id: mail.deal_id, type: 'email', body: `${text}${lender ? ` to ${lender}` : ''}: ${mail.subject}` });
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
      // Internal reminders (to the broker) go without a signature and aren't
      // filed on the client's timeline.
      const internal = Boolean(mail.internal);
      const email = buildEmail({ body: mail.body, senderUserId: senderId, internal, context: { contactId: mail.contact_id, dealId: mail.deal_id, loanId: mail.loan_id } });
      const files = mail.attachments ? JSON.parse(mail.attachments).map((a) => ({ ...a, data: Buffer.from(a.data, 'base64') })) : [];
      if (account) {
        const sent = await outlook.sendMail(account, { to: mail.to_email, subject: mail.subject, email, files });
        db.update('outbox', mail.id, { status: 'sent', sent_via: internal ? 'outlook_internal' : 'outlook', sent_at: nowIso(), error: null });
        if (!internal) outlook.recordEmail(account, {
          graphId: sent.graphId, conversationId: sent.conversationId, direction: 'out',
          fromEmail: account.email, fromName: account.display_name, to: sent.to, cc: [],
          subject: mail.subject, body: email.plain, preview: null, hasAttachments: files.length > 0, webLink: sent.webLink, sentAt: nowIso(),
        }, { contactIds: [mail.contact_id], dealId: mail.deal_id, lenderId: mail.lender_id });
      } else if (t) {
        await t.sendMail({
          from, to: mail.to_email, subject: mail.subject, text: email.text, html: email.html,
          attachments: [
            ...email.attachments.map((a) => ({ filename: a.filename, content: a.data, contentType: a.mime, cid: a.cid })),
            ...files.map((a) => ({ filename: a.filename, content: a.data, contentType: a.mime })),
          ],
        });
        db.update('outbox', mail.id, { status: 'sent', sent_via: 'smtp', sent_at: nowIso(), error: null });
        if (!internal) logActivity(mail, 'Email sent');
      } else {
        db.update('outbox', mail.id, { status: 'logged', sent_at: nowIso(), error: null });
        if (!internal) logActivity(mail, 'Email logged (no Outlook or SMTP connected)');
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
