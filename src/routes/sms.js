'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const sms = require('../services/sms');
const { HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const router = express.Router();

router.get('/status', (req, res) => {
  const c = sms.config();
  const me = db.one('SELECT sms_from, phone FROM users WHERE id = ?', req.user.id);
  res.json({
    configured: sms.isConfigured(),
    app: req.user.role === 'admin' ? { username: c.username, default_from: c.defaultFrom, has_key: Boolean(c.apiKey) } : undefined,
    default_from: c.defaultFrom,
    my_from: me.sms_from,
    my_phone: me.phone,
    team: db.all('SELECT name, sms_from FROM users WHERE active = 1 ORDER BY name'),
  });
});

router.put('/config', auth.requireRole('admin'), (req, res) => {
  sms.saveConfig(req.body || {});
  res.json({ configured: sms.isConfigured() });
});

// Each user's own (ClickSend-verified) mobile number to send from.
router.put('/me', (req, res) => {
  const raw = req.body?.sms_from;
  const from = raw ? sms.normaliseMobile(raw) : null;
  if (raw && !from) throw new HttpError(400, 'Enter a mobile number like 0412 345 678');
  db.update('users', req.user.id, { sms_from: from });
  res.json({ sms_from: from });
});

router.post('/test', async (req, res) => {
  const me = db.one('SELECT sms_from, phone, name FROM users WHERE id = ?', req.user.id);
  const to = sms.normaliseMobile(me.sms_from || me.phone);
  if (!to) throw new HttpError(400, 'Save your mobile number first');
  const id = sms.queueSms({ to, body: `Test SMS from your CRM. If you can read this, texting is working. - ${db.getSetting('business_name', 'EFH CRM')}`, senderUserId: req.user.id });
  await sms.processSms();
  res.json(db.one('SELECT id, status, error, from_number FROM sms_messages WHERE id = ?', id));
});

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.contact_id) { where.push('s.contact_id = ?'); params.push(req.query.contact_id); }
  if (req.query.status) { where.push('s.status = ?'); params.push(req.query.status); }
  res.json({
    rows: db.all(
      `SELECT s.*, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, a.name AS automation_name, t.name AS template_name
       FROM sms_messages s LEFT JOIN contacts c ON c.id = s.contact_id LEFT JOIN automations a ON a.id = s.automation_id
       LEFT JOIN email_templates t ON t.id = s.template_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT 300`,
      ...params,
    ),
  });
});

// One-off text to a contact, sent straight away.
router.post('/', async (req, res) => {
  const row = pick(req.body, ['contact_id', 'deal_id', 'body']);
  requireFields(row, ['contact_id', 'body']);
  notFound(db.one('SELECT 1 FROM contacts WHERE id = ?', row.contact_id), 'Contact');
  const { id, reason } = sms.queueForContact({ contactId: row.contact_id, dealId: row.deal_id, body: row.body, senderUserId: req.user.id });
  if (!id) throw new HttpError(400, reason);
  await sms.processSms();
  res.status(201).json(db.one('SELECT * FROM sms_messages WHERE id = ?', id));
});

router.post('/process', async (req, res) => res.json({ processed: await sms.processSms() }));

router.post('/:id/cancel', (req, res) => {
  const id = intParam(req.params.id);
  const msg = notFound(db.one('SELECT * FROM sms_messages WHERE id = ?', id), 'SMS');
  if (msg.status !== 'queued') throw new HttpError(400, 'Only queued texts can be cancelled');
  db.update('sms_messages', id, { status: 'cancelled' });
  res.json({ ok: true });
});

router.post('/:id/retry', async (req, res) => {
  const id = intParam(req.params.id);
  const msg = notFound(db.one('SELECT * FROM sms_messages WHERE id = ?', id), 'SMS');
  if (!['failed', 'cancelled'].includes(msg.status)) throw new HttpError(400, 'Only failed or cancelled texts can be retried');
  db.update('sms_messages', id, { status: 'queued', error: null, send_after: new Date().toISOString() });
  await sms.processSms();
  res.json(db.one('SELECT * FROM sms_messages WHERE id = ?', id));
});

module.exports = router;
