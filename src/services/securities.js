'use strict';
// Securities that aren't property, for commercial and business loans: a rent
// roll, a General Security Agreement (GSA) over a business's assets, or a
// guarantee. Held on a deal while it's in progress, then copied to the loan on
// the mortgage tracker when it settles.
const db = require('../db');
const { nowIso, HttpError } = require('../util');
// $250k, $1.25m
const compactMoney = (n) => (n >= 1e6 ? `$${String(Math.round((n / 1e6) * 100) / 100)}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);

const TYPES = {
  rent_roll: { label: 'Rent roll', short: 'Rent roll' },
  gsa: { label: 'General Security Agreement (GSA)', short: 'GSA' },
  guarantee: { label: 'Guarantee', short: 'Guarantee' },
};
// Loan types these can be added to.
const LOAN_TYPES = ['commercial', 'business_loan'];
const FIELDS = ['type', 'contact_id', 'name', 'description', 'value', 'limit_amount', 'managements', 'ppsr_number', 'notes'];

const SELECT = `SELECT s.*, TRIM(c.first_name || ' ' || COALESCE(c.last_name, '')) AS contact_name, c.entity_type AS contact_entity_type
  FROM other_securities s LEFT JOIN contacts c ON c.id = s.contact_id`;

// "GSA – Jones Holdings Pty Ltd", "Guarantee – Mia Jones (limit $250k)", "Rent roll – Harbour Realty (120 managements)".
// "limit $250k", "120 managements, $1.5m".
const detail = (s) => (s.type === 'guarantee' ? (s.limit_amount ? `limit ${compactMoney(s.limit_amount)}` : 'unlimited')
    : s.type === 'rent_roll' ? [s.managements ? `${s.managements} managements` : null, s.value ? compactMoney(s.value) : null].filter(Boolean).join(', ')
      : s.value ? compactMoney(s.value) : null) || null;
function summary(s) {
  const who = s.contact_name || s.name;
  const extra = detail(s);
  return `${TYPES[s.type]?.short || s.type}${who ? ` – ${who}` : ''}${extra ? ` (${extra})` : ''}`;
}
const shape = (s) => ({ ...s, label: TYPES[s.type]?.label || s.type, detail: detail(s), summary: summary(s) });

const forLoan = (loanId) => db.all(`${SELECT} WHERE s.loan_id = ? ORDER BY s.id`, loanId).map(shape);
const forDeal = (dealId) => db.all(`${SELECT} WHERE s.deal_id = ? ORDER BY s.id`, dealId).map(shape);

function clean(body, { partial = false } = {}) {
  const row = {};
  for (const k of FIELDS) if (body?.[k] !== undefined) row[k] = body[k] === '' ? null : body[k];
  if (!partial || 'type' in row) {
    if (!TYPES[row.type]) throw new HttpError(400, 'Choose rent roll, GSA or guarantee');
  }
  for (const k of ['value', 'limit_amount', 'managements']) {
    if (row[k] === null || row[k] === undefined) continue;
    const n = Number(row[k]);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Amounts must be positive numbers');
    row[k] = k === 'managements' ? Math.round(n) : n;
  }
  if (row.contact_id) {
    row.contact_id = Number(row.contact_id);
    if (!db.one('SELECT 1 FROM contacts WHERE id = ?', row.contact_id)) throw new HttpError(400, 'That contact doesn\'t exist');
  }
  for (const k of ['name', 'description', 'ppsr_number', 'notes']) if (typeof row[k] === 'string') row[k] = row[k].trim().slice(0, k === 'notes' ? 2000 : 300) || null;
  return row;
}

function create(body) {
  const dealId = Number(body?.deal_id) || null;
  const loanId = Number(body?.loan_id) || null;
  if (!dealId === !loanId) throw new HttpError(400, 'Add it to a deal or a loan');
  const parent = dealId ? db.one('SELECT loan_type FROM deals WHERE id = ?', dealId) : db.one('SELECT loan_type FROM loans WHERE id = ?', loanId);
  if (!parent) throw new HttpError(404, dealId ? 'Deal not found' : 'Loan not found');
  if (!LOAN_TYPES.includes(parent.loan_type)) throw new HttpError(400, 'Rent rolls, GSAs and guarantees can be added to commercial and business loans');
  const row = clean(body);
  if (row.type !== 'rent_roll' && !row.contact_id && !row.name) throw new HttpError(400, row.type === 'gsa' ? 'Who is granting the GSA?' : 'Who is giving the guarantee?');
  const id = db.insert('other_securities', { ...row, deal_id: dealId, loan_id: loanId });
  return get(id);
}

function update(id, body) {
  if (!db.one('SELECT 1 FROM other_securities WHERE id = ?', id)) throw new HttpError(404, 'Security not found');
  db.update('other_securities', id, { ...clean(body, { partial: true }), updated_at: nowIso() });
  return get(id);
}

const get = (id) => {
  const s = db.one(`${SELECT} WHERE s.id = ?`, id);
  return s ? shape(s) : null;
};
const remove = (id) => db.run('DELETE FROM other_securities WHERE id = ?', id).changes > 0;

// At settlement: the deal's securities go onto the loan created from it.
function copyDealToLoan(dealId, loanId) {
  if (db.one('SELECT 1 FROM other_securities WHERE loan_id = ?', loanId)) return 0;
  const rows = db.all('SELECT * FROM other_securities WHERE deal_id = ?', dealId);
  for (const { id, deal_id: _d, loan_id: _l, created_at: _c, updated_at: _u, ...rest } of rows) db.insert('other_securities', { ...rest, loan_id: loanId });
  return rows.length;
}

module.exports = { TYPES, LOAN_TYPES, forLoan, forDeal, create, update, get, remove, copyDealToLoan, summary };
