'use strict';
// The other professionals on a deal: real estate agent, solicitor/conveyancer,
// buyer's agent and so on. Each is a record in the partners directory, so the
// same agent or solicitor can be picked again on later deals.
const db = require('../db');
const { HttpError } = require('../util');

const ROLES = {
  real_estate_agent: { label: 'Real estate agent', types: ['real_estate'] },
  solicitor: { label: 'Solicitor / conveyancer', types: ['solicitor', 'conveyancer'] },
  buyers_agent: { label: "Buyer's agent", types: ['buyers_agent'] },
  accountant: { label: 'Accountant', types: ['accountant'] },
  financial_planner: { label: 'Financial planner', types: ['financial_planner'] },
  builder: { label: 'Builder', types: ['builder'] },
};
const isRole = (role) => typeof role === 'string' && Object.hasOwn(ROLES, role);
const PARTNER_FIELDS = ['name', 'company', 'type', 'email', 'phone', 'mobile', 'notes'];

const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// Finds the directory entry for a new party, reusing one with the same email
// (or the same name and company) rather than creating a duplicate.
function findOrCreatePartner(role, input) {
  const p = Object.fromEntries(PARTNER_FIELDS.map((k) => [k, clean(input?.[k])]));
  if (!p.name) throw new HttpError(400, `Enter a name for the ${ROLES[role].label.toLowerCase()}`);
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new HttpError(400, `${p.email} doesn't look like an email address`);
  const existing = (p.email && db.one('SELECT id FROM referral_partners WHERE lower(email) = lower(?)', p.email))
    || db.one("SELECT id FROM referral_partners WHERE lower(name) = lower(?) AND lower(COALESCE(company,'')) = lower(?)", p.name, p.company || '');
  if (existing) {
    // Fill in anything we didn't already have.
    const row = db.one('SELECT * FROM referral_partners WHERE id = ?', existing.id);
    const patch = Object.fromEntries(['company', 'email', 'phone', 'mobile'].filter((k) => p[k] && !row[k]).map((k) => [k, p[k]]));
    if (Object.keys(patch).length) db.update('referral_partners', existing.id, patch);
    return existing.id;
  }
  const types = ROLES[role].types;
  return db.insert('referral_partners', { ...p, type: types.includes(p.type) ? p.type : types[0] });
}

// Sets (or replaces) who fills a role on a deal. `party` is
// { partner_id } or { new_partner: {...} }, plus optional notes.
function set(dealId, role, party, userId = null) {
  if (!isRole(role)) throw new HttpError(400, 'Unknown role');
  const deal = db.one('SELECT id, contact_id FROM deals WHERE id = ?', dealId);
  if (!deal) throw new HttpError(404, 'Deal not found');
  let partnerId = Number(party?.partner_id) || null;
  if (partnerId && !db.one('SELECT 1 FROM referral_partners WHERE id = ?', partnerId)) throw new HttpError(400, 'That contact is no longer in your directory');
  if (!partnerId && party?.new_partner) partnerId = findOrCreatePartner(role, party.new_partner);
  if (!partnerId) throw new HttpError(400, `Choose the ${ROLES[role].label.toLowerCase()}`);
  const before = db.one('SELECT partner_id FROM deal_parties WHERE deal_id = ? AND role = ?', dealId, role);
  db.run(
    `INSERT INTO deal_parties (deal_id, role, partner_id, notes) VALUES (?, ?, ?, ?)
     ON CONFLICT (deal_id, role) DO UPDATE SET partner_id = excluded.partner_id, notes = excluded.notes`,
    dealId, role, partnerId, clean(party?.notes),
  );
  if (before?.partner_id !== partnerId) {
    const p = db.one('SELECT name, company FROM referral_partners WHERE id = ?', partnerId);
    db.insert('activities', {
      contact_id: deal.contact_id, deal_id: dealId, user_id: userId, type: 'system',
      body: `${ROLES[role].label}: ${p.name}${p.company ? ` (${p.company})` : ''}`,
    });
  }
  return partnerId;
}

function remove(dealId, role) {
  if (!db.run('DELETE FROM deal_parties WHERE deal_id = ? AND role = ?', dealId, role).changes) throw new HttpError(404, 'Not found on this deal');
}

// Sets several roles at once (the New deal form). Blank entries are skipped.
function setMany(dealId, list, userId) {
  if (!Array.isArray(list)) return;
  for (const party of list) {
    if (!party || (!party.partner_id && !party.new_partner)) continue;
    set(dealId, party.role, party, userId);
  }
}

function list(dealId) {
  const rows = db.all(
    `SELECT dp.role, dp.notes, p.id, p.name, p.company, p.type, p.email, p.phone, p.mobile
     FROM deal_parties dp JOIN referral_partners p ON p.id = dp.partner_id WHERE dp.deal_id = ?`,
    dealId,
  );
  const order = Object.keys(ROLES);
  return rows
    .map((r) => ({ ...r, role_label: ROLES[r.role].label, first_name: String(r.name).split(/\s+/)[0] }))
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

// Merge-field shape: { real_estate_agent: {...}, solicitor: {...}, ... }.
function forContext(dealId) {
  return Object.fromEntries(list(dealId).map((p) => [p.role, p]));
}

module.exports = { ROLES, isRole, set, setMany, remove, list, forContext, findOrCreatePartner };
