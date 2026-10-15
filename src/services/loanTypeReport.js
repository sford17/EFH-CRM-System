'use strict';
// Reports → Loan types: what kinds of loans were settled in a period (home,
// commercial, business, SMSF…), month by month, what's in the pipeline now,
// and the loans on the books.
const db = require('../db');
const { LOAN_TYPES, loanTypeLabel } = require('../constants');
const settlements = require('./settlementReport');

const round2 = (n) => Math.round(n * 100) / 100;
const TRACKER_LABELS = { credit_card: 'Credit card', hecs: 'HECS-HELP' };
const order = (key) => {
  const i = LOAN_TYPES.findIndex((t) => t.key === key);
  return i === -1 ? 99 : i;
};

// Totals for a list of { loan_type, amount, commission? } grouped by type, biggest first.
function group(rows, amountKey = 'loan_amount') {
  const total = rows.reduce((s, r) => s + (r[amountKey] || 0), 0);
  const map = new Map();
  for (const r of rows) {
    const key = r.loan_type || 'other';
    const g = map.get(key) || { key, label: loanTypeLabel(key) === 'Other' && TRACKER_LABELS[key] ? TRACKER_LABELS[key] : loanTypeLabel(key), count: 0, volume: 0, commission: 0 };
    g.count += 1;
    g.volume += r[amountKey] || 0;
    g.commission += r.commission || 0;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, volume: round2(g.volume), commission: round2(g.commission), average: g.count ? Math.round(g.volume / g.count) : 0, share: total ? Math.round((g.volume / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.volume - a.volume || order(a.key) - order(b.key));
}

function settledDeals({ period, ownerId = null }) {
  return db.all(
    `${settlements.DEAL_SQL} WHERE d.stage = 'settled' AND d.settlement_date BETWEEN ? AND ? ${ownerId ? 'AND d.owner_id = ?' : ''} ORDER BY d.settlement_date, d.id`,
    period.from, period.to, ...(ownerId ? [ownerId] : []),
  ).map((d) => ({ ...d, loan_type: d.loan_type || 'other', commission: settlements.commissionFor(d)?.net ?? 0 }));
}

function report({ period, ownerId = null }) {
  const settled = settledDeals({ period, ownerId });
  const types = group(settled);
  // Month by month, with a column for each type that settled in the period.
  const months = settlements.monthsBetween(period.from.slice(0, 7), period.to.slice(0, 7)).map((month) => {
    const inMonth = settled.filter((d) => d.settlement_date.startsWith(month));
    const by = Object.fromEntries(types.map((t) => {
      const list = inMonth.filter((d) => d.loan_type === t.key);
      return [t.key, { count: list.length, volume: round2(list.reduce((s, d) => s + (d.loan_amount || 0), 0)) }];
    }));
    return { month, by, count: inMonth.length, volume: round2(inMonth.reduce((s, d) => s + (d.loan_amount || 0), 0)) };
  });
  const pipeline = group(db.all(
    `SELECT loan_type, loan_amount FROM deals WHERE stage NOT IN ('settled', 'lost') ${ownerId ? 'AND owner_id = ?' : ''}`,
    ...(ownerId ? [ownerId] : []),
  ));
  // Loans you arranged that are still active on clients' trackers.
  const book = group(db.all(
    `SELECT n.loan_type, COALESCE(n.balance, n.limit_amount, 0) AS owing FROM loans n JOIN contacts c ON c.id = n.contact_id
     WHERE n.status = 'active' AND n.arranged_by_us = 1 ${ownerId ? 'AND c.owner_id = ?' : ''}`,
    ...(ownerId ? [ownerId] : []),
  ), 'owing');
  return {
    period,
    totals: { count: settled.length, volume: round2(settled.reduce((s, d) => s + (d.loan_amount || 0), 0)), commission: round2(settled.reduce((s, d) => s + d.commission, 0)) },
    types,
    months,
    pipeline,
    book,
  };
}

const CSV_COLUMNS = ['Settlement date', 'Loan type', 'Purpose', 'Client', 'Deal', 'Lender', 'Loan amount', 'Commission', 'Broker'];
function csvRows({ period, ownerId = null }) {
  return settledDeals({ period, ownerId }).map((d) => ({
    'Settlement date': d.settlement_date, 'Loan type': loanTypeLabel(d.loan_type), Purpose: String(d.loan_purpose || '').replace(/_/g, ' '),
    Client: [d.client, d.co_borrower].map((n) => (n || '').trim()).filter(Boolean).join(' & '), Deal: d.title, Lender: d.lender_name || '',
    'Loan amount': d.loan_amount || 0, Commission: d.commission, Broker: d.owner_name || '',
  }));
}

module.exports = { report, csvRows, CSV_COLUMNS };
