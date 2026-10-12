'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

// ---- Users ------------------------------------------------------------------
const users = express.Router();

users.get('/', (req, res) => {
  res.json({ rows: db.all('SELECT id, name, email, role, phone, active, created_at FROM users ORDER BY active DESC, name') });
});

users.post('/', auth.requireRole('admin'), (req, res) => {
  const row = pick(req.body, ['name', 'email', 'role', 'phone', 'password']);
  requireFields(row, ['name', 'email', 'password']);
  if (String(row.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const { password, ...rest } = row;
  const id = db.insert('users', { ...rest, password_hash: auth.hashPassword(password) });
  res.status(201).json(db.one('SELECT id, name, email, role, phone, active FROM users WHERE id = ?', id));
});

users.patch('/:id', auth.requireRole('admin'), (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM users WHERE id = ?', id), 'User');
  const row = pick(req.body, ['name', 'email', 'role', 'phone', 'active']);
  if (id === req.user.id && (row.active === 0 || (row.role && row.role !== 'admin'))) {
    throw new HttpError(400, 'You cannot deactivate or demote your own account');
  }
  if (req.body?.password) {
    if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    row.password_hash = auth.hashPassword(req.body.password);
  }
  db.update('users', id, row);
  if (row.active === 0 || row.password_hash) db.run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json(db.one('SELECT id, name, email, role, phone, active FROM users WHERE id = ?', id));
});

// ---- Settings -----------------------------------------------------------------
const SETTING_KEYS = ['business_name', 'business_phone', 'business_email', 'business_website', 'acl_number', 'monthly_settlement_target'];
const settings = express.Router();

settings.get('/', (req, res) => {
  res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, db.getSetting(k, '')])));
});

settings.put('/', auth.requireRole('admin'), (req, res) => {
  for (const k of SETTING_KEYS) if (req.body && k in req.body) db.setSetting(k, String(req.body[k] ?? ''));
  res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, db.getSetting(k, '')])));
});

// ---- Simple CRUD resources -----------------------------------------------------
function simpleCrud(table, fields, { required = ['name'], list, label = 'Record' } = {}) {
  const r = express.Router();
  r.get('/', (req, res) => res.json({ rows: list ? list() : db.all(`SELECT * FROM ${table} ORDER BY name`) }));
  r.post('/', (req, res) => {
    const row = pick(req.body, fields);
    requireFields(row, required);
    const id = db.insert(table, row);
    res.status(201).json(db.one(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
  r.patch('/:id', (req, res) => {
    const id = intParam(req.params.id);
    notFound(db.one(`SELECT 1 FROM ${table} WHERE id = ?`, id), label);
    db.update(table, id, pick(req.body, fields));
    res.json(db.one(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
  r.delete('/:id', (req, res) => {
    const id = intParam(req.params.id);
    notFound(db.one(`SELECT 1 FROM ${table} WHERE id = ?`, id), label);
    db.run(`DELETE FROM ${table} WHERE id = ?`, id);
    res.json({ ok: true });
  });
  return r;
}

const lenders = simpleCrud(
  'lenders',
  ['name', 'website', 'upfront_pct', 'trail_pct', 'clawback_months', 'bdm_name', 'bdm_email', 'bdm_phone', 'notes', 'active'],
  {
    label: 'Lender',
    list: () => db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM deals d WHERE d.lender_id = l.id AND d.stage = 'settled') AS settled_count,
              (SELECT COALESCE(SUM(loan_amount),0) FROM deals d WHERE d.lender_id = l.id AND d.stage = 'settled') AS settled_volume
       FROM lenders l ORDER BY l.active DESC, l.name`,
    ),
  },
);

const partners = simpleCrud(
  'referral_partners',
  ['name', 'company', 'type', 'email', 'phone', 'mobile', 'referral_fee_pct', 'notes', 'active'],
  {
    label: 'Partner',
    list: () => db.all(
      `SELECT p.*,
         (SELECT COUNT(*) FROM contacts c WHERE c.referral_partner_id = p.id) AS referrals,
         (SELECT COUNT(*) FROM deals d WHERE d.referral_partner_id = p.id AND d.stage = 'settled') AS settled_count,
         (SELECT COALESCE(SUM(loan_amount),0) FROM deals d WHERE d.referral_partner_id = p.id AND d.stage = 'settled') AS settled_volume,
         (SELECT COUNT(*) FROM deal_parties dp WHERE dp.partner_id = p.id) AS deals_involved
       FROM referral_partners p ORDER BY p.active DESC, p.name`,
    ),
  },
);

const lenderLogos = require('../services/lenderLogos');
lenders.post('/:id/logo', (req, res) => {
  const assetId = lenderLogos.setLogo(intParam(req.params.id), req.body?.image);
  res.json({ logo_asset_id: assetId });
});
lenders.post('/:id/logo/fetch', async (req, res) => {
  const assetId = await lenderLogos.fetchFromWebsite(intParam(req.params.id));
  res.json({ logo_asset_id: assetId });
});
lenders.delete('/:id/logo', (req, res) => {
  lenderLogos.removeLogo(intParam(req.params.id));
  res.json({ ok: true });
});

module.exports = { users, settings, lenders, partners };
