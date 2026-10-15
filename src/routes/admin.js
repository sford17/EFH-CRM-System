'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

// ---- Users ------------------------------------------------------------------
const users = express.Router();

users.get('/', (req, res) => {
  res.json({
    rows: db.all(`SELECT id, name, email, role, phone, active, created_at, last_login_at, (totp_enabled_at IS NOT NULL) AS mfa_enabled,
        (SELECT MAX(created_at) FROM user_invites i WHERE i.user_id = users.id AND i.used_at IS NULL AND i.expires_at > ?) AS link_sent_at
      FROM users ORDER BY active DESC, name`, new Date().toISOString()),
  });
});

// Without a password, the person chooses their own from the welcome email.
users.post('/', auth.requireRole('admin'), (req, res) => {
  const row = pick(req.body, ['name', 'email', 'role', 'phone', 'password']);
  requireFields(row, ['name', 'email']);
  if (row.password && String(row.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.one('SELECT 1 FROM users WHERE email = ?', String(row.email).trim())) throw new HttpError(409, 'Someone on the team already uses that email address');
  const { password, ...rest } = row;
  const id = db.insert('users', { ...rest, email: String(rest.email).trim(), password_hash: password ? auth.hashPassword(password) : require('../services/invites').unusablePassword() });
  res.status(201).json(db.one('SELECT id, name, email, role, phone, active FROM users WHERE id = ?', id));
});

// Emails a welcome link (or, for someone who has signed in before, a link to choose a new password).
users.post('/:id/welcome', auth.requireRole('admin'), async (req, res) => {
  res.json(await require('../services/invites').send(intParam(req.params.id), req.user.id, `${req.protocol}://${req.get('host')}`));
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
const SETTING_KEYS = ['business_name', 'business_phone', 'business_email', 'business_website', 'acl_number', 'monthly_settlement_target', 'app_url', 'google_review_link',
  'valuation_rule', 'valuation_recent_months', 'valuation_ignore_estimates', 'settlement_letter_auto_send', 'fact_find_reminders'];
const SETTING_DEFAULTS = { valuation_rule: 'highest_recent', valuation_recent_months: '12', valuation_ignore_estimates: '1', settlement_letter_auto_send: '0', fact_find_reminders: '1' };
const settingValues = () => Object.fromEntries(SETTING_KEYS.map((k) => [k, db.getSetting(k, SETTING_DEFAULTS[k] ?? '')]));
const settings = express.Router();

settings.get('/', (req, res) => res.json(settingValues()));

settings.put('/', auth.requireRole('admin'), (req, res) => {
  if (req.body?.google_review_link && !/^https:\/\/\S+$/i.test(String(req.body.google_review_link).trim())) {
    throw new HttpError(400, 'The Google review link should start with https:// (copy it from your Google Business Profile → "Ask for reviews")');
  }
  if (req.body?.app_url && !/^https?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/i.test(String(req.body.app_url).trim())) {
    throw new HttpError(400, 'The CRM web address should look like http://localhost:3000 or https://crm.example.com.au');
  }
  if (req.body?.valuation_rule != null && !['highest_recent', 'latest'].includes(req.body.valuation_rule)) throw new HttpError(400, 'Choose how property values are worked out');
  if (req.body?.valuation_recent_months != null && req.body.valuation_recent_months !== ''
    && !(Number.isInteger(Number(req.body.valuation_recent_months)) && Number(req.body.valuation_recent_months) >= 0 && Number(req.body.valuation_recent_months) <= 120)) {
    throw new HttpError(400, 'Recent valuations: enter a number of months from 0 to 120 (0 = no limit)');
  }
  for (const k of SETTING_KEYS) if (req.body && k in req.body) db.setSetting(k, String(req.body[k] ?? SETTING_DEFAULTS[k] ?? ''));
  res.json(settingValues());
});

// ---- Simple CRUD resources -----------------------------------------------------
function simpleCrud(table, fields, { required = ['name'], list, label = 'Record' } = {}) {
  const r = express.Router();
  r.get('/', (req, res) => res.json({ rows: list ? list(req) : db.all(`SELECT * FROM ${table} ORDER BY name`) }));
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
  ['name', 'website', 'upfront_pct', 'clawback_months', 'notes', 'active'],
  {
    label: 'Lender',
    // Includes the primary BDM and the signed-in broker's own accreditation.
    list: (req) => db.all(
      `SELECT l.*, (SELECT COUNT(*) FROM deals d WHERE d.lender_id = l.id AND d.stage = 'settled') AS settled_count,
              (SELECT COALESCE(SUM(loan_amount),0) FROM deals d WHERE d.lender_id = l.id AND d.stage = 'settled') AS settled_volume,
              (SELECT COUNT(*) FROM deals d WHERE d.lender_id = l.id AND d.stage NOT IN ('settled','lost')) AS open_deals,
              b.id AS bdm_id, b.name AS bdm_name, b.email AS bdm_email, COALESCE(b.mobile, b.phone) AS bdm_phone,
              (SELECT COUNT(*) FROM lender_contacts c WHERE c.lender_id = l.id) AS contact_count,
              a.accreditation_number, a.status AS accreditation_status, a.renewal_due
       FROM lenders l
       LEFT JOIN lender_contacts b ON b.id = (SELECT id FROM lender_contacts c WHERE c.lender_id = l.id ORDER BY c.is_primary DESC, c.role != 'bdm', c.id LIMIT 1)
       LEFT JOIN lender_accreditations a ON a.lender_id = l.id AND a.user_id = ?
       ORDER BY l.active DESC, l.name`,
      req.user.id,
    ),
  },
);

const lenderService = require('../services/lenders');

// One lender: details, contacts, everyone's accreditation, emails and open deals.
lenders.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const lender = notFound(db.one('SELECT * FROM lenders WHERE id = ?', id), 'Lender');
  const { listEmails } = require('./outlook');
  res.json({
    ...lender,
    contacts: lenderService.contactsFor(id),
    accreditations: lenderService.accreditationsFor(id),
    emails: listEmails({ lenderId: id, limit: 50 }),
    outbox: db.all(
      `SELECT o.id, o.to_email, o.subject, o.status, o.sent_at, o.send_after, o.contact_id,
              c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
       FROM outbox o LEFT JOIN contacts c ON c.id = o.contact_id
       WHERE o.lender_id = ? AND COALESCE(o.sent_via,'') != 'outlook' ORDER BY o.id DESC LIMIT 50`,
      id,
    ),
    deals: db.all(
      `SELECT d.id, d.title, d.stage, d.loan_amount, d.application_ref, d.contact_id, d.owner_id,
              c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
       FROM deals d JOIN contacts c ON c.id = d.contact_id
       WHERE d.lender_id = ? AND d.stage NOT IN ('settled','lost') ORDER BY d.stage_changed_at DESC`,
      id,
    ),
    contact_roles: lenderService.CONTACT_ROLES,
    accreditation_statuses: lenderService.ACCREDITATION_STATUSES,
  });
});

lenders.post('/:id/contacts', (req, res) => res.status(201).json(lenderService.addContact(intParam(req.params.id), req.body || {})));
lenders.patch('/contacts/:contactId', (req, res) => res.json(lenderService.updateContact(intParam(req.params.contactId), req.body || {})));
lenders.delete('/contacts/:contactId', (req, res) => {
  lenderService.removeContact(intParam(req.params.contactId));
  res.json({ ok: true });
});

// PUT /lenders/:id/accreditations/:userId creates or updates that broker's accreditation.
lenders.put('/:id/accreditations/:userId', (req, res) => {
  res.json(lenderService.saveAccreditation(intParam(req.params.id), intParam(req.params.userId), req.body || {}, req.user));
});
lenders.delete('/accreditations/:accId', (req, res) => {
  lenderService.removeAccreditation(intParam(req.params.accId), req.user);
  res.json({ ok: true });
});

const partners = simpleCrud(
  'referral_partners',
  ['name', 'company', 'type', 'email', 'phone', 'mobile', 'referral_fee_pct', 'gst_registered', 'sms_updates', 'newsletter_opt_in', 'notes', 'active'],
  {
    label: 'Partner',
    list: () => db.all(
      `SELECT p.*,
         (SELECT COUNT(*) FROM contacts c WHERE c.referral_partner_id = p.id) AS referrals,
         (SELECT COUNT(*) FROM deals d WHERE d.referral_partner_id = p.id AND d.stage = 'settled') AS settled_count,
         (SELECT COALESCE(SUM(loan_amount),0) FROM deals d WHERE d.referral_partner_id = p.id AND d.stage = 'settled') AS settled_volume,
         (SELECT COUNT(*) FROM deal_parties dp WHERE dp.partner_id = p.id) AS deals_involved,
         (SELECT COUNT(*) FROM sms_messages s WHERE s.partner_id = p.id AND s.status IN ('sent','logged')) AS texts_sent
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
