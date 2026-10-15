'use strict';
const express = require('express');
const db = require('../db');
const csv = require('../csv');
const automation = require('../services/automation');
const { listEmails } = require('./outlook');
const household = require('../services/household');
const { nowIso, HttpError, parseTags } = require('../util');
const { pick, requireFields, notFound, intParam, like } = require('./helpers');

const router = express.Router();

const FIELDS = [
  'first_name', 'last_name', 'email', 'mobile', 'phone', 'dob', 'address', 'suburb', 'state', 'postcode',
  'employment_type', 'employer', 'annual_income', 'marital_status', 'dependants', 'status', 'lead_source',
  'referral_partner_id', 'owner_id', 'tags', 'marketing_opt_in', 'sms_opt_out', 'next_review_date', 'google_reviewed_at', 'background',
  'entity_type', 'abn', 'acn', 'trust_type',
];
const borrowers = require('../services/borrowers');
const CONTACT_TYPES = ['call', 'email', 'sms', 'meeting'];

// Tags are stored as a clean, de-duplicated comma list ('' when none).
function normalise(row) {
  if ('tags' in row) row.tags = [...new Set(parseTags(row.tags))].join(',');
  if ('marketing_opt_in' in row && row.marketing_opt_in === null) row.marketing_opt_in = 0;
  if ('sms_opt_out' in row && row.sms_opt_out === null) row.sms_opt_out = 0;
  if ('entity_type' in row) {
    if (!row.entity_type) row.entity_type = 'person';
    if (!borrowers.ENTITY_TYPES.includes(row.entity_type)) throw new HttpError(400, 'Type must be person, company or trust');
    // A company or trust has one name (kept in first_name) and no personal details.
    if (row.entity_type !== 'person') {
      row.last_name = null;
      for (const k of ['dob', 'marital_status', 'dependants', 'employment_type']) if (k in row) row[k] = null;
    }
  }
  for (const k of ['abn', 'acn']) if (row[k]) row[k] = String(row[k]).replace(/[^\d]/g, '').replace(k === 'abn' ? /^(\d{2})(\d{3})(\d{3})(\d{3})$/ : /^(\d{3})(\d{3})(\d{3})$/, k === 'abn' ? '$1 $2 $3 $4' : '$1 $2 $3');
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
  if (req.query.entity_type) { where.push('c.entity_type = ?'); params.push(req.query.entity_type); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT c.*, u.name AS owner_name, p.name AS partner_name,
       (SELECT COUNT(*) FROM deals d WHERE (d.contact_id = c.id OR d.id IN (SELECT deal_id FROM deal_borrowers WHERE contact_id = c.id)) AND d.stage NOT IN ('settled','lost')) AS open_deals
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
  contact.relationships = household.relatedTo(id);
  contact.household = household.household(id);
  // Companies and trusts this person is linked to, or the people behind this company or trust.
  contact.entities = contact.entity_type === 'person' ? borrowers.entitiesOf(id) : [];
  contact.people = contact.entity_type === 'person' ? [] : borrowers.peopleOf(id);
  // Deals for the household, and for companies and trusts they're linked to.
  const hh = [...new Set([...contact.household.map((m) => m.id), ...contact.entities.map((e) => e.id)])];
  contact.deals = db.all(
    `SELECT d.*, l.name AS lender_name, l.logo_asset_id AS lender_logo_id,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, ${borrowers.coNamesSql('deal', 'd')} AS co_borrower_name
     FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id JOIN contacts c ON c.id = d.contact_id
     WHERE ${borrowers.involving('deal', 'd', hh)} ORDER BY d.created_at DESC`,
    ...borrowers.params(hh),
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
  contact.emails = db.all("SELECT id, to_email, subject, status, send_after, sent_at FROM outbox WHERE contact_id = ? AND COALESCE(sent_via,'') != 'outlook' AND internal = 0 ORDER BY id DESC LIMIT 50", id);
  contact.mail = listEmails({ contactIds: [id], limit: 50 });
  contact.appointments = db.all(
    `SELECT a.*, u.name AS owner_name FROM appointments a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.contact_id = ? ORDER BY a.start_at DESC LIMIT 30`,
    id,
  );
  contact.reviews = db.all(
    'SELECT id, title, review_date, status, sent_at, sent_to, updated_at FROM reviews WHERE contact_id = ? ORDER BY review_date DESC, id DESC',
    id,
  );
  contact.sms = db.all('SELECT id, body, status, error, from_number, send_after, sent_at FROM sms_messages WHERE contact_id = ? ORDER BY id DESC LIMIT 50', id);
  contact.sign_requests = require('../services/adobeSign').list({ contactId: id });
  res.json(contact);
});

router.post('/', (req, res) => {
  const row = normalise(pick(req.body, FIELDS));
  requireFields(row, ['first_name']);
  if (row.owner_id === undefined) row.owner_id = req.user.id;
  if (row.entity_type && row.entity_type !== 'person' && row.marketing_opt_in === undefined) row.marketing_opt_in = 0;
  const id = db.insert('contacts', row);
  db.insert('activities', { contact_id: id, user_id: req.user.id, type: 'system', body: 'Contact created' });
  // A company or trust isn't a new enquiry: new-lead automations are for people.
  if (!row.entity_type || row.entity_type === 'person') automation.emit('contact.created', { contactId: id });
  res.status(201).json(db.one('SELECT * FROM contacts WHERE id = ?', id));
});

router.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const before = notFound(db.one('SELECT * FROM contacts WHERE id = ?', id), 'Contact');
  const row = normalise(pick(req.body, FIELDS));
  if (row.first_name === null) throw new HttpError(400, 'first_name cannot be empty');
  db.update('contacts', id, { ...row, updated_at: nowIso() });
  household.syncAddress(id, before, row);
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

// ---- Google review requests ------------------------------------------------------
const reviews = require('../services/googleReviews');
router.get('/:id/review-request', (req, res) => res.json(reviews.draft(intParam(req.params.id), req.user.id)));
router.post('/:id/review-request', async (req, res) => {
  const b = req.body || {};
  res.status(201).json(await reviews.send(intParam(req.params.id), {
    email: b.email ? { subject: b.email.subject, body: b.email.body } : null,
    sms: b.sms ? { body: b.sms.body } : null,
    dealId: Number(b.deal_id) || null,
  }, req.user.id));
});
router.put('/:id/google-review', (req, res) => res.json(reviews.markReviewed(intParam(req.params.id), Boolean(req.body?.reviewed), req.user.id)));

// ---- Related contacts ---------------------------------------------------------
// Body: { related_id } to link an existing contact, or { new_contact: {...} }
// to create the partner on the spot (surname and address pre-filled).
router.post('/:id/relationships', (req, res) => {
  const id = intParam(req.params.id);
  const me = notFound(db.one('SELECT * FROM contacts WHERE id = ?', id), 'Contact');
  const { relId, relatedId } = db.transaction(() => {
    let relatedId = Number(req.body?.related_id) || null;
    if (!relatedId && req.body?.new_contact) {
      const nc = normalise(pick(req.body.new_contact, FIELDS));
      requireFields(nc, ['first_name']);
      const entity = nc.entity_type && nc.entity_type !== 'person';
      // From a person: surname and address carry over. From a company or trust: just the owner and status.
      const fromPerson = me.entity_type === 'person';
      relatedId = db.insert('contacts', {
        ...(fromPerson && !entity ? { last_name: me.last_name } : {}), ...(entity ? { marketing_opt_in: 0 } : {}),
        status: me.status, owner_id: me.owner_id, referral_partner_id: me.referral_partner_id, lead_source: me.lead_source,
        ...(fromPerson ? { address: me.address, suburb: me.suburb, state: me.state, postcode: me.postcode } : {}), ...nc,
      });
      db.insert('activities', { contact_id: relatedId, user_id: req.user.id, type: 'system', body: `Contact created as ${me.first_name}'s ${String(req.body.relationship || 'partner').replace('_', ' ')}` });
    }
    if (!relatedId) throw new HttpError(400, 'Choose a contact to link');
    const relId = household.link(id, relatedId, pick(req.body, ['relationship', 'shared_finances', 'copy_address', 'notes']));
    return { relId, relatedId };
  });
  res.status(201).json({ id: relId, related_id: relatedId, relationships: household.relatedTo(id) });
});

// Who a document or email for this contact can be addressed to.
router.get('/:id/household', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT id FROM contacts WHERE id = ?', id), 'Contact');
  // On a deal: everyone borrowing on it too (and the people behind a company or trust).
  const rows = household.household(id);
  const dealId = Number(req.query.deal_id) || null;
  if (dealId) {
    const onDeal = borrowers.all('deal', dealId);
    if (onDeal.some((b) => b.id === id)) {
      for (const p of [...onDeal, ...borrowers.addresseesFor(onDeal)]) {
        if (!rows.some((r) => r.id === p.id)) rows.push({ id: p.id, first_name: p.first_name, last_name: p.last_name, email: p.email, mobile: p.mobile, entity_type: p.entity_type });
      }
    }
  }
  res.json({ rows, related: household.relatedTo(id) });
});

router.patch('/relationships/:relId', (req, res) => {
  res.json(household.update(intParam(req.params.relId), pick(req.body, ['relationship', 'shared_finances', 'notes'])));
});

router.delete('/relationships/:relId', (req, res) => {
  household.unlink(intParam(req.params.relId));
  res.json({ ok: true });
});

module.exports = router;
