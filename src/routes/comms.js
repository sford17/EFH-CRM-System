'use strict';
const express = require('express');
const db = require('../db');
const mailer = require('../services/mailer');
const { render, buildContext } = require('../services/templating');
const { HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const templates = express.Router();
const FIELDS = ['name', 'category', 'subject', 'body', 'sms_body'];

templates.get('/', (req, res) => res.json({ rows: db.all('SELECT * FROM email_templates ORDER BY category, name') }));

templates.post('/', (req, res) => {
  const row = pick(req.body, FIELDS);
  requireFields(row, ['name', 'subject', 'body']);
  const id = db.insert('email_templates', row);
  res.status(201).json(db.one('SELECT * FROM email_templates WHERE id = ?', id));
});

templates.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM email_templates WHERE id = ?', id), 'Template');
  db.update('email_templates', id, pick(req.body, FIELDS));
  res.json(db.one('SELECT * FROM email_templates WHERE id = ?', id));
});

templates.delete('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM email_templates WHERE id = ?', id), 'Template');
  db.run('DELETE FROM email_templates WHERE id = ?', id);
  res.json({ ok: true });
});

templates.post('/:id/preview', (req, res) => {
  const t = notFound(db.one('SELECT * FROM email_templates WHERE id = ?', intParam(req.params.id)), 'Template');
  const ctx = buildContext({ contactId: req.body?.contact_id, dealId: req.body?.deal_id, userId: req.user.id, latestDeal: true });
  res.json({
    subject: render(t.subject, ctx), body: render(t.body, ctx), to: ctx.contact?.email || null,
    sms: t.sms_body ? render(t.sms_body, ctx) : null, mobile: ctx.contact?.mobile || null,
  });
});

templates.post('/:id/send', async (req, res) => {
  const id = intParam(req.params.id);
  if (!req.body?.contact_id && !req.body?.deal_id) throw new HttpError(400, 'Choose a contact or deal to send to');
  const { id: outboxId, reason } = mailer.queueTemplate(id, {
    contactId: req.body.contact_id, dealId: req.body.deal_id, userId: req.user.id,
  });
  if (!outboxId) throw new HttpError(400, reason);
  await mailer.processOutbox();
  res.status(201).json(db.one('SELECT id, status, sent_via, error FROM outbox WHERE id = ?', outboxId));
});

const outbox = express.Router();

outbox.get('/', (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) { where = 'WHERE o.status = ?'; params.push(req.query.status); }
  res.json({
    rows: db.all(
      `SELECT o.*, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, a.name AS automation_name
       FROM outbox o LEFT JOIN contacts c ON c.id = o.contact_id LEFT JOIN automations a ON a.id = o.automation_id
       ${where} ORDER BY o.id DESC LIMIT 300`,
      ...params,
    ),
  });
});

// Ad-hoc email to a contact, sent straight away.
outbox.post('/', async (req, res) => {
  const row = pick(req.body, ['contact_id', 'deal_id', 'subject', 'body', 'to_email']);
  requireFields(row, ['subject', 'body']);
  const contact = row.contact_id ? db.one('SELECT email FROM contacts WHERE id = ?', row.contact_id) : null;
  if (!row.to_email && !contact?.email) throw new HttpError(400, 'This contact has no email address');
  const id = mailer.queueEmail({
    to: row.to_email || contact?.email, subject: row.subject, body: row.body, contactId: row.contact_id, dealId: row.deal_id,
    senderUserId: req.user.id,
  });
  await mailer.processOutbox();
  res.status(201).json(db.one('SELECT * FROM outbox WHERE id = ?', id));
});

outbox.post('/process', async (req, res) => res.json({ processed: await mailer.processOutbox() }));

outbox.post('/:id/cancel', (req, res) => {
  const id = intParam(req.params.id);
  const mail = notFound(db.one('SELECT * FROM outbox WHERE id = ?', id), 'Email');
  if (mail.status !== 'queued') throw new HttpError(400, 'Only queued emails can be cancelled');
  db.update('outbox', id, { status: 'cancelled' });
  res.json({ ok: true });
});

outbox.post('/:id/retry', (req, res) => {
  const id = intParam(req.params.id);
  const mail = notFound(db.one('SELECT * FROM outbox WHERE id = ?', id), 'Email');
  if (!['failed', 'cancelled'].includes(mail.status)) throw new HttpError(400, 'Only failed or cancelled emails can be retried');
  db.update('outbox', id, { status: 'queued', error: null, send_after: new Date().toISOString() });
  res.json({ ok: true });
});

module.exports = { templates, outbox };
