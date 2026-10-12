'use strict';
const db = require('../db');
const { render, buildContext } = require('./templating');
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

function queueEmail({ to, subject, body, contactId = null, dealId = null, templateId = null, automationId = null, sendAfter = null }) {
  if (!to) throw new Error('Recipient has no email address');
  return db.insert('outbox', {
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
function queueTemplate(templateId, { contactId, dealId, automationId, sendAfter, to, userId } = {}) {
  const template = db.one('SELECT * FROM email_templates WHERE id = ?', templateId);
  if (!template) return { id: null, reason: `Template ${templateId} not found` };
  const ctx = buildContext({ contactId, dealId, userId });
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
  });
  return { id, reason: null };
}

// Sends everything due in the outbox. Without SMTP configured, emails are
// marked "logged" so the workflow can be exercised without sending anything.
async function processOutbox() {
  const due = db.all("SELECT * FROM outbox WHERE status = 'queued' AND send_after <= ? ORDER BY id LIMIT 50", nowIso());
  const t = getTransport();
  const from = process.env.SMTP_FROM || db.getSetting('business_email') || 'crm@localhost';
  for (const mail of due) {
    try {
      if (t) await t.sendMail({ from, to: mail.to_email, subject: mail.subject, text: mail.body });
      db.update('outbox', mail.id, { status: t ? 'sent' : 'logged', sent_at: nowIso(), error: null });
      if (mail.contact_id) {
        db.insert('activities', {
          contact_id: mail.contact_id,
          deal_id: mail.deal_id,
          type: 'email',
          body: `Email ${t ? 'sent' : 'logged (SMTP not configured)'}: ${mail.subject}`,
        });
      }
    } catch (err) {
      db.update('outbox', mail.id, { status: 'failed', error: String(err.message || err) });
    }
  }
  return due.length;
}

module.exports = { queueEmail, queueTemplate, processOutbox };
