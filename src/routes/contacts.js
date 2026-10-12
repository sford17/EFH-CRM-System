'use strict';
const express = require('express');
const db = require('../db');
const csv = require('../csv');
const automation = require('../services/automation');
const { listEmails } = require('./outlook');
const { nowIso, HttpError, parseTags } = require('../util');
const { pick, requireFields, notFound, intParam, like } = require('./helpers');

const router = express.Router();

const FIELDS = [
  'first_name', 'last_name', 'email', 'mobile', 'phone', 'dob', 'address', 'suburb', 'state', 'postcode',
  'employment_type', 'employer', 'annual_income', 'marital_status', 'dependants', 'status', 'lead_source',
  'referral_partner_id', 'owner_id', 'tags', 'marketing_opt_in', 'sms_opt_out', 'next_review_date', 'background',
];
const CONTACT_TYPES = ['call', 'email', 'sms', 'meeting'];

// Tags are stored as a clean, de-duplicated comma list ('' when none).
function normalise(row) {
  if ('tags' in row) row.tags = [...new Set(parseTags(row.tags))].join(',');
  if ('marketing_opt_in' in row && row.marketing_opt_in === null) row.marketing_opt_in = 0;
  if ('sms_opt_out' in row && row.sms_opt_out === null) row.sms_opt_out = 0;
  return row;
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push(`(c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.mobile LIKE ? ESCAPE '\\')`);
    params.push(like(req.query.q), like(req.query.q), like(req.query.q));
  }
  if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }
  if (req.query.owner_id) { where.push('c.owner_id = ?'); params.push(req.query.owner_id); }
  if (req.query.tag) { where.push("(',' || c.tags || ',') LIKE ? ESCAPE '\\'"); params.push(like(`,${req.query.tag},`)); }
  if (req.query.lead_source) { where.push('c.lead_source = ?'); params.push(req.query.lead_source); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT c.*, u.name AS owner_name, p.name AS partner_name,
       (SELECT COUNT(*) FROM deals d WHERE d.contact_id = c.id AND d.stage NOT IN ('settled','lost')) AS open_deals
     FROM contacts c LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN referral_partners p ON p.id = c.referral_partner_id
     ${whereSql} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const { total } = db.one(`SELECT COUNT(*) AS total FROM contacts c ${whereSql}`, ...params);
  res.json({ rows, total });
});

router.get('/export.csv', (req, res) => {
  const rows = db.all(`SELECT id, ${FIELDS.join(', ')}, created_at FROM contacts ORDER BY id`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(csv.stringify(rows, ['id', ...FIELDS, 'created_at']));
});

router.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const contact = notFound(db.one(
    `SELECT c.*, u.name AS owner_name, p.name AS partner_name FROM contacts c
     LEFT JOIN users u ON u.id = c.owner_id LEFT JOIN referral_partners p ON p.id = c.referral_partner_id WHERE c.id = ?`,
    id,
  ), 'Contact');
  contact.deals = db.all(
    `SELECT d.*, l.name AS lender_name FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id
     WHERE d.contact_id = ? OR d.co_borrower_id = ? ORDER BY d.created_at DESC`,
    id, id,
  );
  contact.tasks = db.all(
    `SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to
     WHERE t.contact_id = ? ORDER BY t.status, t.due_date`,
    id,
  );
  contact.activities = db.all(
    `SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.contact_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    id,
  );
  contact.emails = db.all("SELECT id, to_email, subject, status, send_after, sent_at FROM outbox WHERE contact_id = ? AND COALESCE(sent_via,'') != 'outlook' ORDER BY id DESC LIMIT 50", id);
  contact.mail = listEmails({ contactIds: [id], limit: 50 });
  contact.appointments = db.all(
    `SELECT a.*, u.name AS owner_name FROM appointments a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.contact_id = ? ORDER BY a.start_at DESC LIMIT 30`,
    id,
  );
  contact.sms = db.all('SELECT id, body, status, error, from_number, send_after, sent_at FROM sms_messages WHERE contact_id = ? ORDER BY id DESC LIMIT 50', id);
  res.json(contact);
});

router.post('/', (req, res) => {
  const row = normalise(pick(req.body, FIELDS));
  requireFields(row, ['first_name']);
  if (row.owner_id === undefined) row.owner_id = req.user.id;
  const id = db.insert('contacts', row);
  db.insert('activities', { contact_id: id, user_id: req.user.id, type: 'system', body: 'Contact created' });
  automation.emit('contact.created', { contactId: id });
  res.status(201).json(db.one('SELECT * FROM contacts WHERE id = ?', id));
});

router.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const before = notFound(db.one('SELECT * FROM contacts WHERE id = ?', id), 'Contact');
  const row = normalise(pick(req.body, FIELDS));
  if (row.first_name === null) throw new HttpError(400, 'first_name cannot be empty');
  db.update('contacts', id, { ...row, updated_at: nowIso() });
  if (row.status && row.status !== before.status) {
    db.insert('activities', { contact_id: id, user_id: req.user.id, type: 'system', body: `Status changed: ${before.status} → ${row.status}` });
    automation.emit('contact.status_changed', { contactId: id, from_status: before.status, to_status: row.status });
  }
  res.json(db.one('SELECT * FROM contacts WHERE id = ?', id));
});

router.delete('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM contacts WHERE id = ?', id), 'Contact');
  db.run('DELETE FROM contacts WHERE id = ?', id);
  res.json({ ok: true });
});

// Log a call / email / meeting / note against the contact (and optionally a deal).
router.post('/:id/activities', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM contacts WHERE id = ?', id), 'Contact');
  const row = pick(req.body, ['type', 'body', 'deal_id']);
  requireFields(row, ['body']);
  const actId = db.insert('activities', { ...row, type: row.type || 'note', contact_id: id, user_id: req.user.id });
  if (CONTACT_TYPES.includes(row.type)) db.update('contacts', id, { last_contacted_at: nowIso(), updated_at: nowIso() });
  res.status(201).json(db.one('SELECT * FROM activities WHERE id = ?', actId));
});

module.exports = router;
