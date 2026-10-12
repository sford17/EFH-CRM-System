'use strict';
const express = require('express');
const db = require('../db');
const tracker = require('../services/tracker');
const { nowIso, HttpError, today } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const router = express.Router();

const PROPERTY_FIELDS = ['contact_id', 'co_owner_id', 'address', 'suburb', 'state', 'postcode', 'property_type', 'usage', 'bedrooms',
  'purchase_date', 'purchase_price', 'rental_income_weekly', 'status', 'notes'];
const VALUATION_FIELDS = ['valuation_date', 'amount', 'method', 'provider', 'lender_id', 'reference', 'notes'];
const LOAN_FIELDS = ['contact_id', 'co_borrower_id', 'lender_id', 'lender_name', 'loan_type', 'account_number', 'product_name', 'limit_amount',
  'balance', 'balance_date', 'interest_rate', 'rate_type', 'fixed_expiry_date', 'repayment_type', 'io_expiry_date', 'repayment_amount',
  'repayment_frequency', 'offset_balance', 'settlement_date', 'loan_term_years', 'status', 'arranged_by_us', 'notes'];
const ASSET_FIELDS = ['contact_id', 'asset_type', 'description', 'institution', 'value', 'value_date', 'notes'];

const contactExists = (id) => notFound(db.one('SELECT id FROM contacts WHERE id = ?', id), 'Contact');

router.get('/contacts/:id', (req, res) => {
  const id = intParam(req.params.id);
  contactExists(id);
  res.json(tracker.summary(id));
});

// ---- Properties ------------------------------------------------------------------
router.post('/properties', (req, res) => {
  const row = pick(req.body, PROPERTY_FIELDS);
  requireFields(row, ['contact_id', 'address']);
  contactExists(row.contact_id);
  const id = db.insert('properties', row);
  // Optional first valuation, e.g. the value the client tells you.
  const v = req.body?.valuation;
  if (v?.amount) {
    db.insert('valuations', { method: 'client_estimate', valuation_date: today(), ...pick(v, VALUATION_FIELDS), property_id: id, created_by: req.user.id });
  }
  res.status(201).json(db.one('SELECT * FROM properties WHERE id = ?', id));
});

router.patch('/properties/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM properties WHERE id = ?', id), 'Property');
  const row = pick(req.body, PROPERTY_FIELDS.filter((f) => f !== 'contact_id'));
  if (row.address === null) throw new HttpError(400, 'A property needs an address');
  db.update('properties', id, { ...row, updated_at: nowIso() });
  res.json(db.one('SELECT * FROM properties WHERE id = ?', id));
});

router.delete('/properties/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM properties WHERE id = ?', id), 'Property');
  db.run('DELETE FROM properties WHERE id = ?', id);
  res.json({ ok: true });
});

// ---- Valuations ----------------------------------------------------------------------
router.post('/properties/:id/valuations', (req, res) => {
  const propertyId = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM properties WHERE id = ?', propertyId), 'Property');
  const row = pick(req.body, VALUATION_FIELDS);
  requireFields(row, ['valuation_date', 'amount', 'method']);
  if (!(Number(row.amount) > 0)) throw new HttpError(400, 'Enter the valuation amount');
  const id = db.insert('valuations', { ...row, property_id: propertyId, created_by: req.user.id });
  tracker.touch('properties', propertyId);
  res.status(201).json(db.one('SELECT * FROM valuations WHERE id = ?', id));
});

router.patch('/valuations/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM valuations WHERE id = ?', id), 'Valuation');
  db.update('valuations', id, pick(req.body, VALUATION_FIELDS));
  res.json(db.one('SELECT * FROM valuations WHERE id = ?', id));
});

router.delete('/valuations/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM valuations WHERE id = ?', id), 'Valuation');
  db.run('DELETE FROM valuations WHERE id = ?', id);
  res.json({ ok: true });
});

// Valuations across all clients, e.g. "every AVM in the last 6 months".
router.get('/valuations', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.method) { where.push('v.method = ?'); params.push(req.query.method); }
  if (req.query.from) { where.push('v.valuation_date >= ?'); params.push(req.query.from); }
  if (req.query.contact_id) { where.push('(p.contact_id = ? OR p.co_owner_id = ?)'); params.push(req.query.contact_id, req.query.contact_id); }
  res.json({
    rows: db.all(
      `SELECT v.*, p.address, p.contact_id, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, l.name AS lender_name
       FROM valuations v JOIN properties p ON p.id = v.property_id JOIN contacts c ON c.id = p.contact_id
       LEFT JOIN lenders l ON l.id = v.lender_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY v.valuation_date DESC, v.id DESC LIMIT 500`,
      ...params,
    ),
    methods: tracker.VALUATION_METHODS,
  });
});

// ---- Loans -----------------------------------------------------------------------------
function setSecurities(loanId, ids, contactId) {
  if (!Array.isArray(ids)) return;
  db.run('DELETE FROM loan_securities WHERE loan_id = ?', loanId);
  for (const pid of ids.map(Number).filter(Boolean)) {
    const p = db.one('SELECT id FROM properties WHERE id = ? AND (contact_id = ? OR co_owner_id = ?)', pid, contactId, contactId);
    if (!p) throw new HttpError(400, 'A security property belongs to a different client');
    db.run('INSERT INTO loan_securities (loan_id, property_id) VALUES (?, ?)', loanId, pid);
  }
}

router.post('/loans', (req, res) => {
  const row = pick(req.body, LOAN_FIELDS);
  requireFields(row, ['contact_id']);
  contactExists(row.contact_id);
  if (!row.lender_id && !row.lender_name) throw new HttpError(400, 'Choose a lender (or type its name)');
  const id = db.transaction(() => {
    const loanId = db.insert('loans', row);
    setSecurities(loanId, req.body.security_ids, row.contact_id);
    return loanId;
  });
  res.status(201).json(db.one('SELECT * FROM loans WHERE id = ?', id));
});

router.patch('/loans/:id', (req, res) => {
  const id = intParam(req.params.id);
  const loan = notFound(db.one('SELECT * FROM loans WHERE id = ?', id), 'Loan');
  const row = pick(req.body, LOAN_FIELDS.filter((f) => f !== 'contact_id'));
  db.transaction(() => {
    db.update('loans', id, { ...row, updated_at: nowIso() });
    setSecurities(id, req.body.security_ids, loan.contact_id);
  });
  res.json(db.one('SELECT * FROM loans WHERE id = ?', id));
});

router.delete('/loans/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM loans WHERE id = ?', id), 'Loan');
  db.run('DELETE FROM loans WHERE id = ?', id);
  res.json({ ok: true });
});

// ---- Other assets ------------------------------------------------------------------------
router.post('/assets', (req, res) => {
  const row = pick(req.body, ASSET_FIELDS);
  requireFields(row, ['contact_id', 'asset_type']);
  contactExists(row.contact_id);
  const id = db.insert('client_assets', row);
  res.status(201).json(db.one('SELECT * FROM client_assets WHERE id = ?', id));
});

router.patch('/assets/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM client_assets WHERE id = ?', id), 'Asset');
  db.update('client_assets', id, { ...pick(req.body, ASSET_FIELDS.filter((f) => f !== 'contact_id')), updated_at: nowIso() });
  res.json(db.one('SELECT * FROM client_assets WHERE id = ?', id));
});

router.delete('/assets/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM client_assets WHERE id = ?', id), 'Asset');
  db.run('DELETE FROM client_assets WHERE id = ?', id);
  res.json({ ok: true });
});

module.exports = router;
