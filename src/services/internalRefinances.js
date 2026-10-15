'use strict';
// Internal refinance register: clients the broker has moved from one of their
// own loans (and lenders) to a new one. Both sides are kept for sale/trail-book
// records and to watch clawback periods on the old loan.
const db = require('../db');
const { today, nowIso, addMonths, HttpError } = require('../util');
const household = require('./household');

const round2 = (n) => Math.round(n * 100) / 100;
const STATUSES = { needs_review: 'Needs review', in_progress: 'In progress', completed: 'Completed' };
const LOAN_TYPES = {
  home_loan: 'Home loan', investment_loan: 'Investment loan', line_of_credit: 'Line of credit', construction: 'Construction',
  bridging: 'Bridging', commercial: 'Commercial', personal: 'Personal', car: 'Car', other: 'Other',
};
const PURPOSE_TYPE = { investment: 'investment_loan', construction: 'construction', commercial: 'commercial' };
const SIDE = ['lender_id', 'lender_name', 'borrowers', 'account_number', 'product', 'loan_type', 'loan_amount', 'interest_rate', 'rate_type', 'settlement_date', 'broker_id', 'loan_id'];
const FIELDS = [
  'contact_id', 'client_name', 'status', 'reason', 'clawback_amount', 'cashback', 'notes', 'new_deal_id', 'old_balance', 'old_discharge_date',
  ...SIDE.map((f) => `old_${f}`), ...SIDE.map((f) => `new_${f}`),
];
const DATES = ['old_settlement_date', 'old_discharge_date', 'new_settlement_date'];
const NUMBERS = ['old_loan_amount', 'old_balance', 'old_interest_rate', 'new_loan_amount', 'new_interest_rate', 'clawback_amount', 'cashback'];
const IDS = ['contact_id', 'old_loan_id', 'old_lender_id', 'old_broker_id', 'new_deal_id', 'new_loan_id', 'new_lender_id', 'new_broker_id'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const nameOf = (c) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '');

// Whole months between two ISO dates (floor).
function monthsBetween(from, to) {
  if (!from || !to || to < from) return null;
  let m = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  if (to.slice(8, 10) < from.slice(8, 10)) m -= 1;
  return Math.max(0, m);
}

// Cleans a body into column values; throws a friendly 400 for bad input.
function clean(body, { partial = false } = {}) {
  const row = {};
  for (const f of FIELDS) {
    if (!Object.hasOwn(body || {}, f)) continue;
    let v = body[f];
    if (v === '' || v === undefined) v = null;
    if (v !== null && DATES.includes(f)) {
      if (!DATE.test(String(v))) throw new HttpError(400, 'Dates must be in YYYY-MM-DD format');
    } else if (v !== null && NUMBERS.includes(f)) {
      v = Number(String(v).replace(/[$,\s%]/g, ''));
      if (!Number.isFinite(v)) throw new HttpError(400, 'Amounts and rates must be numbers');
    } else if (v !== null && IDS.includes(f)) {
      v = Number(v);
      if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, 'Invalid link');
    } else if (v !== null) {
      v = String(v).trim().slice(0, 2000) || null;
    }
    row[f] = v;
  }
  if (row.status !== undefined && row.status !== null && !Object.hasOwn(STATUSES, row.status)) throw new HttpError(400, 'Choose a status');
  if (row.status === null) delete row.status;
  for (const side of ['old', 'new']) {
    const t = row[`${side}_rate_type`];
    if (t && !['variable', 'fixed', 'split'].includes(t)) throw new HttpError(400, 'Rate type must be variable, fixed or split');
  }
  // Names follow a chosen lender or client unless typed.
  for (const side of ['old', 'new']) {
    const id = row[`${side}_lender_id`];
    if (id && !row[`${side}_lender_name`]) {
      const l = db.one('SELECT name FROM lenders WHERE id = ?', id);
      if (!l) throw new HttpError(400, 'That lender no longer exists');
      row[`${side}_lender_name`] = l.name;
    }
  }
  if (row.contact_id && !row.client_name) row.client_name = nameOf(db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', row.contact_id)) || null;
  if (!partial && !row.client_name) throw new HttpError(400, 'Choose the client (or type their name)');
  if (partial && Object.hasOwn(row, 'client_name') && !row.client_name) throw new HttpError(400, 'The client name can\'t be blank');
  return row;
}

const BASE_SQL = `
  SELECT r.*, ol.clawback_months AS old_clawback_months, ol.logo_asset_id AS old_lender_logo_id, nl.logo_asset_id AS new_lender_logo_id,
         ob.name AS old_broker_name, nb.name AS new_broker_name, cu.name AS created_by_name, d.title AS new_deal_title, d.stage AS new_deal_stage,
         lo.deal_id AS old_deal_id, lo.status AS old_loan_status
  FROM internal_refinances r
  LEFT JOIN lenders ol ON ol.id = r.old_lender_id
  LEFT JOIN lenders nl ON nl.id = r.new_lender_id
  LEFT JOIN users ob ON ob.id = r.old_broker_id
  LEFT JOIN users nb ON nb.id = r.new_broker_id
  LEFT JOIN users cu ON cu.id = r.created_by
  LEFT JOIN deals d ON d.id = r.new_deal_id
  LEFT JOIN loans lo ON lo.id = r.old_loan_id`;

// The date the client switched: the new loan's settlement, else when the old one was paid out.
const switchDate = (r) => r.new_settlement_date || r.old_discharge_date || null;

function shape(r) {
  const moved = switchDate(r);
  const held = monthsBetween(r.old_settlement_date, moved);
  const clawbackMonths = r.old_clawback_months ?? null;
  const clawbackUntil = r.old_settlement_date && clawbackMonths != null ? addMonths(r.old_settlement_date, clawbackMonths) : null;
  // Upfront paid on the old loan (when we wrote it through this CRM).
  const oldUpfront = r.old_deal_id
    ? db.one("SELECT COALESCE(SUM(amount),0) AS a, COUNT(*) AS n FROM commissions WHERE deal_id = ? AND type = 'upfront' AND status != 'cancelled'", r.old_deal_id)
    : null;
  return {
    ...r,
    status_label: STATUSES[r.status],
    old_loan_type_label: LOAN_TYPES[r.old_loan_type] || r.old_loan_type,
    new_loan_type_label: LOAN_TYPES[r.new_loan_type] || r.new_loan_type,
    switch_date: moved,
    months_held: held,
    clawback_until: clawbackUntil,
    within_clawback: Boolean(clawbackUntil && moved && moved < clawbackUntil),
    old_upfront_commission: oldUpfront?.n ? round2(oldUpfront.a) : null,
    lender_changed: r.old_lender_id && r.new_lender_id ? r.old_lender_id !== r.new_lender_id
      : (r.old_lender_name || '').trim().toLowerCase() !== (r.new_lender_name || '').trim().toLowerCase(),
    increase: r.new_loan_amount != null && (r.old_balance ?? r.old_loan_amount) != null ? round2(r.new_loan_amount - (r.old_balance ?? r.old_loan_amount)) : null,
  };
}

function get(id) {
  const r = db.one(`${BASE_SQL} WHERE r.id = ?`, id);
  return r ? shape(r) : null;
}

const sum = (rows, key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));

// Entries in a period (by switch date; entries with no dates yet by when they were added).
function list({ period = null, ownerId = null, lenderId = null, status = null, contactId = null, q = null } = {}) {
  const where = [];
  const args = [];
  if (period) {
    where.push("COALESCE(r.new_settlement_date, r.old_discharge_date, substr(r.created_at,1,10)) BETWEEN ? AND ?");
    args.push(period.from, period.to);
  }
  if (ownerId) { where.push('(r.new_broker_id = ? OR r.old_broker_id = ?)'); args.push(ownerId, ownerId); }
  if (lenderId) { where.push('(r.old_lender_id = ? OR r.new_lender_id = ?)'); args.push(lenderId, lenderId); }
  if (status && Object.hasOwn(STATUSES, status)) { where.push('r.status = ?'); args.push(status); }
  if (contactId) {
    const ids = household.householdIds(contactId);
    where.push(`r.contact_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (q) {
    where.push("(r.client_name LIKE ? ESCAPE '\\' OR r.old_borrowers LIKE ? ESCAPE '\\' OR r.new_borrowers LIKE ? ESCAPE '\\' OR r.old_account_number LIKE ? ESCAPE '\\' OR r.new_account_number LIKE ? ESCAPE '\\')");
    const like = `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like, like, like);
  }
  const rows = db.all(
    `${BASE_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(r.new_settlement_date, r.old_discharge_date, substr(r.created_at,1,10)) DESC, r.id DESC`,
    ...args,
  ).map(shape);

  // Lender-to-lender movements, biggest first.
  const flows = new Map();
  for (const r of rows) {
    const key = `${r.old_lender_name || '?'} → ${r.new_lender_name || '?'}`;
    const f = flows.get(key) || { from: r.old_lender_name || 'Unknown', to: r.new_lender_name || 'Unknown', count: 0, volume: 0 };
    f.count += 1;
    f.volume = round2(f.volume + (r.new_loan_amount || 0));
    flows.set(key, f);
  }
  return {
    rows,
    flows: [...flows.values()].sort((a, b) => b.count - a.count || b.volume - a.volume),
    totals: {
      count: rows.length,
      completed_count: rows.filter((r) => r.status === 'completed').length,
      needs_review_count: rows.filter((r) => r.status === 'needs_review').length,
      in_progress_count: rows.filter((r) => r.status === 'in_progress').length,
      old_volume: round2(rows.reduce((s, r) => s + (r.old_balance ?? r.old_loan_amount ?? 0), 0)),
      new_volume: sum(rows, 'new_loan_amount'),
      within_clawback_count: rows.filter((r) => r.within_clawback).length,
      clawback_amount: sum(rows, 'clawback_amount'),
      cashback: sum(rows, 'cashback'),
    },
  };
}

// When completed (and asked to), the old tracker loan is marked refinanced.
function markOld(row, markRefinanced) {
  if (!markRefinanced || row.status !== 'completed' || !row.old_loan_id) return;
  db.run("UPDATE loans SET status = 'refinanced', updated_at = ? WHERE id = ? AND status = 'active'", nowIso(), row.old_loan_id);
}

function checkLinks(row) {
  if (row.contact_id && !db.one('SELECT id FROM contacts WHERE id = ?', row.contact_id)) throw new HttpError(400, 'That client no longer exists');
  if (row.new_deal_id) {
    const clash = db.one('SELECT id FROM internal_refinances WHERE new_deal_id = ? AND id != ?', row.new_deal_id, row.id || 0);
    if (clash) throw new HttpError(400, 'That deal is already recorded as an internal refinance');
  }
}

function create(body, userId) {
  const row = clean(body);
  checkLinks(row);
  const id = db.insert('internal_refinances', { status: 'completed', ...row, source: 'manual', created_by: userId });
  markOld({ ...row, status: row.status || 'completed' }, body.mark_old_refinanced);
  return get(id);
}

function update(id, body) {
  const before = db.one('SELECT * FROM internal_refinances WHERE id = ?', id);
  if (!before) return null;
  const row = clean(body, { partial: true });
  checkLinks({ ...row, id });
  if (Object.keys(row).length) db.update('internal_refinances', id, { ...row, updated_at: nowIso() });
  markOld({ ...before, ...row }, body.mark_old_refinanced);
  return get(id);
}

function remove(id) {
  return db.run('DELETE FROM internal_refinances WHERE id = ?', id).changes > 0;
}

// ---- Prefill from the client's tracker loans and deals ----------------------

function borrowersOf(kind, id) {
  return require('./borrowers').all(kind, id).map((b) => nameOf(b)).filter(Boolean).join(' & ');
}

function loanSide(prefix, n) {
  return {
    [`${prefix}_loan_id`]: n.id,
    [`${prefix}_lender_id`]: n.lender_id,
    [`${prefix}_lender_name`]: n.lender || n.lender_name,
    [`${prefix}_borrowers`]: borrowersOf('loan', n.id),
    [`${prefix}_account_number`]: n.account_number,
    [`${prefix}_product`]: n.product_name,
    [`${prefix}_loan_type`]: n.loan_type,
    [`${prefix}_loan_amount`]: n.limit_amount,
    [`${prefix}_interest_rate`]: n.interest_rate,
    [`${prefix}_rate_type`]: n.rate_type,
    [`${prefix}_settlement_date`]: n.settlement_date,
    [`${prefix}_broker_id`]: n.deal_owner_id || null,
    ...(prefix === 'old' ? { old_balance: n.balance } : {}),
  };
}

function dealSide(d) {
  return {
    new_deal_id: d.id,
    new_lender_id: d.lender_id,
    new_lender_name: d.lender,
    new_borrowers: borrowersOf('deal', d.id),
    new_account_number: d.application_ref,
    new_product: d.product_name,
    new_loan_type: PURPOSE_TYPE[d.loan_purpose] || 'home_loan',
    new_loan_amount: d.loan_amount,
    new_interest_rate: d.interest_rate,
    new_rate_type: d.rate_type,
    new_settlement_date: d.settlement_date,
    new_broker_id: d.owner_id,
    new_loan_id: d.loan_id || null,
  };
}

const LOANS_SQL = `
  SELECT n.*, l.name AS lender, d.owner_id AS deal_owner_id FROM loans n
  LEFT JOIN lenders l ON l.id = n.lender_id LEFT JOIN deals d ON d.id = n.deal_id`;
const DEALS_SQL = `
  SELECT d.*, l.name AS lender, (SELECT id FROM loans WHERE deal_id = d.id) AS loan_id FROM deals d
  LEFT JOIN lenders l ON l.id = d.lender_id`;

function options(contactId) {
  const c = db.one('SELECT id, first_name, last_name FROM contacts WHERE id = ?', contactId);
  if (!c) return null;
  const members = household.household(contactId);
  const ids = members.map((m) => m.id);
  const inIds = ids.map(() => '?').join(',');
  const loans = db.all(`${LOANS_SQL} WHERE n.contact_id IN (${inIds}) OR n.id IN (SELECT loan_id FROM loan_borrowers WHERE contact_id IN (${inIds})) ORDER BY n.status = 'active' DESC, n.settlement_date DESC`, ...ids, ...ids);
  const deals = db.all(`${DEALS_SQL} WHERE (d.contact_id IN (${inIds}) OR d.id IN (SELECT deal_id FROM deal_borrowers WHERE contact_id IN (${inIds}))) AND d.stage != 'lost' ORDER BY d.id DESC`, ...ids, ...ids);
  const loanLabel = (n) => [n.lender || n.lender_name || 'Loan', LOAN_TYPES[n.loan_type], n.account_number ? `#${n.account_number}` : null,
    n.limit_amount ? `$${Math.round(n.limit_amount).toLocaleString('en-AU')}` : null, n.status !== 'active' ? `(${n.status})` : null, n.arranged_by_us ? null : '(arranged elsewhere)'].filter(Boolean).join(' · ');
  return {
    client_name: members.length > 1 ? household.jointName(members) : nameOf(c),
    borrowers: members.map(nameOf).join(' & '),
    loans: loans.map((n) => ({ id: n.id, label: loanLabel(n), status: n.status, arranged_by_us: Boolean(n.arranged_by_us), old: loanSide('old', n), new: loanSide('new', n) })),
    deals: deals.map((d) => ({
      id: d.id, label: `${d.title}${d.lender ? ` · ${d.lender}` : ''}${d.loan_amount ? ` · $${Math.round(d.loan_amount).toLocaleString('en-AU')}` : ''} (${d.stage.replace(/_/g, ' ')})`,
      new: dealSide(d),
    })),
    recorded: list({ contactId }).rows.map((r) => ({ id: r.id, new_deal_id: r.new_deal_id })),
  };
}

// ---- Auto-detection when a refinance deal settles -------------------------

// A refinance deal has settled for a household that still has an active loan
// we arranged with another lender: record it for the broker to check.
function detectFromDeal(dealId) {
  const d = db.one(`${DEALS_SQL} WHERE d.id = ?`, dealId);
  if (!d || d.stage !== 'settled' || d.loan_purpose !== 'refinance') return null;
  if (db.one('SELECT id FROM internal_refinances WHERE new_deal_id = ?', dealId)) return null;
  const ids = household.householdIds(d.contact_id);
  for (const cid of require('./borrowers').coIds('deal', d.id)) if (!ids.includes(cid)) ids.push(cid);
  const inIds = ids.map(() => '?').join(',');
  const candidates = db.all(
    `${LOANS_SQL} WHERE (n.contact_id IN (${inIds}) OR n.id IN (SELECT loan_id FROM loan_borrowers WHERE contact_id IN (${inIds})))
       AND n.status = 'active' AND n.arranged_by_us = 1 AND (n.deal_id IS NULL OR n.deal_id != ?)
       AND n.loan_type NOT IN ('personal','car','credit_card','hecs')
       AND (n.settlement_date IS NULL OR n.settlement_date <= ?)`,
    ...ids, ...ids, dealId, d.settlement_date || today(),
  ).filter((n) => !d.lender_id || n.lender_id !== d.lender_id);
  if (!candidates.length) return null;

  // Prefer a loan secured by the same property as the new one, then the largest.
  const newLoanProps = d.loan_id ? db.all('SELECT property_id FROM loan_securities WHERE loan_id = ?', d.loan_id).map((p) => p.property_id) : [];
  const shared = (n) => db.all('SELECT property_id FROM loan_securities WHERE loan_id = ?', n.id).some((p) => newLoanProps.includes(p.property_id));
  candidates.sort((a, b) => Number(shared(b)) - Number(shared(a)) || (b.balance ?? b.limit_amount ?? 0) - (a.balance ?? a.limit_amount ?? 0));
  const old = candidates[0];

  const members = household.household(d.contact_id);
  const id = db.insert('internal_refinances', {
    contact_id: d.contact_id,
    client_name: members.length > 1 ? household.jointName(members) : nameOf(members[0]),
    status: 'needs_review',
    source: 'auto',
    reason: null,
    ...loanSide('old', old),
    old_discharge_date: d.settlement_date,
    ...dealSide(d),
    notes: candidates.length > 1 ? `Picked automatically from ${candidates.length} loans this client had with other lenders. Check it's the right one.` : null,
  });
  const userId = d.owner_id || db.one("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id")?.id;
  if (userId) {
    db.insert('notifications', {
      user_id: userId,
      message: `Internal refinance recorded for ${nameOf(members[0])}: ${old.lender || old.lender_name || 'old lender'} → ${d.lender || 'new lender'}. Please check the details.`,
      link: `#/reports?tab=refinances&open=${id}`,
    });
  }
  return id;
}

// Flat rows for the CSV export (one line per refinance, old then new).
function csvRows(rows) {
  return rows.map((r) => ({
    Status: r.status_label, 'Switch date': r.switch_date || '', Client: r.client_name, Reason: r.reason || '',
    'Old lender': r.old_lender_name || '', 'Old borrowers': r.old_borrowers || '', 'Old account': r.old_account_number || '', 'Old product': r.old_product || '',
    'Old loan type': r.old_loan_type_label || '', 'Old loan amount': r.old_loan_amount ?? '', 'Old balance at refinance': r.old_balance ?? '',
    'Old rate': r.old_interest_rate ?? '', 'Old rate type': r.old_rate_type || '', 'Old settlement date': r.old_settlement_date || '',
    'Old discharge date': r.old_discharge_date || '', 'Old broker': r.old_broker_name || '', 'Months held': r.months_held ?? '',
    'Clawback period ends': r.clawback_until || '', 'Within clawback': r.within_clawback ? 'Yes' : 'No', 'Old upfront commission': r.old_upfront_commission ?? '',
    'New lender': r.new_lender_name || '', 'New borrowers': r.new_borrowers || '', 'New account': r.new_account_number || '', 'New product': r.new_product || '',
    'New loan type': r.new_loan_type_label || '', 'New loan amount': r.new_loan_amount ?? '', 'New rate': r.new_interest_rate ?? '',
    'New rate type': r.new_rate_type || '', 'New settlement date': r.new_settlement_date || '', 'New broker': r.new_broker_name || '',
    'Clawback amount': r.clawback_amount ?? '', 'Cashback': r.cashback ?? '', Notes: r.notes || '', Source: r.source === 'auto' ? 'Automatic' : 'Manual',
  }));
}

const CSV_COLUMNS = Object.keys(csvRows([{}])[0]);

module.exports = { CSV_COLUMNS, list, get, create, update, remove, options, detectFromDeal, csvRows, monthsBetween, STATUSES, LOAN_TYPES };
