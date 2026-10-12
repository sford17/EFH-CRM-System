'use strict';
// Running settlements: loans settled so far and those expected to settle,
// month by month across an Australian financial year (July–June), with the
// upfront commission on each (after referral fees).
const db = require('../db');
const { today, addMonths } = require('../util');
const { STAGES } = require('../constants');

const round2 = (n) => Math.round(n * 100) / 100;
const PURPOSES = { purchase: 'Purchase', first_home: 'First home', refinance: 'Refinance', investment: 'Investment', construction: 'Construction', top_up: 'Top-up', commercial: 'Commercial', other: 'Other' };
const stageLabel = (k) => STAGES.find((s) => s.key === k)?.label || k;
// Open deals far enough along to count as "expected" when they have no date yet.
const LATE_STAGES = ['application_lodged', 'conditional_approval', 'unconditional_approval', 'settlement_booked'];

// FY2027 = July 2026 to June 2027.
function fyOf(date) {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 7 ? y + 1 : y;
}
const fyRange = (fy) => ({ from: `${fy - 1}-07`, to: `${fy}-06` });
const fyLabel = (fy) => `FY${String(fy).slice(2)} (Jul ${fy - 1} – Jun ${fy})`;

function monthsBetween(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(`${m}-01`, 1).slice(0, 7)) out.push(m);
  return out;
}

const DEAL_SQL = `
  SELECT d.id, d.title, d.stage, d.loan_purpose, d.rate_type, d.loan_amount, d.settlement_date, d.contact_id, d.owner_id,
         c.first_name || ' ' || COALESCE(c.last_name,'') AS client,
         cb.first_name || ' ' || COALESCE(cb.last_name,'') AS co_borrower,
         l.name AS lender_name, l.logo_asset_id AS lender_logo_id, l.upfront_pct, p.referral_fee_pct, u.name AS owner_name
  FROM deals d JOIN contacts c ON c.id = d.contact_id
  LEFT JOIN contacts cb ON cb.id = d.co_borrower_id
  LEFT JOIN lenders l ON l.id = d.lender_id
  LEFT JOIN referral_partners p ON p.id = d.referral_partner_id
  LEFT JOIN users u ON u.id = d.owner_id`;

// Upfront commission net of referral fees: from the commission ledger once a
// deal has settled, otherwise estimated from the lender's rate.
function commissionFor(d) {
  const estimate = () => {
    if (!d.loan_amount || d.upfront_pct == null) return null;
    const upfront = round2((d.loan_amount * d.upfront_pct) / 100);
    const fee = d.referral_fee_pct ? round2((upfront * d.referral_fee_pct) / 100) : 0;
    return { upfront, referral_fee: fee, net: round2(upfront - fee), status: 'estimated' };
  };
  if (d.stage !== 'settled') return estimate();
  const rows = db.all("SELECT type, amount, status FROM commissions WHERE deal_id = ? AND type IN ('upfront','referral_fee') AND status != 'cancelled'", d.id);
  const upfrontRows = rows.filter((r) => r.type === 'upfront');
  if (!upfrontRows.length) return estimate();
  const upfront = round2(upfrontRows.reduce((s, r) => s + r.amount, 0));
  const fee = round2(-rows.filter((r) => r.type === 'referral_fee').reduce((s, r) => s + r.amount, 0));
  return { upfront, referral_fee: fee, net: round2(upfront - fee), status: upfrontRows.every((r) => r.status === 'received') ? 'received' : 'expected' };
}

function shape(d, now) {
  const commission = commissionFor(d);
  return {
    deal_id: d.id,
    title: d.title,
    contact_id: d.contact_id,
    client: [d.client, d.co_borrower].map((n) => (n || '').trim()).filter(Boolean).join(' & '),
    lender_name: d.lender_name,
    lender_logo_id: d.lender_logo_id,
    loan_type: PURPOSES[d.loan_purpose] || 'Loan',
    rate_type: d.rate_type,
    loan_amount: d.loan_amount || 0,
    settlement_date: d.settlement_date,
    stage: d.stage,
    stage_label: stageLabel(d.stage),
    settled: d.stage === 'settled',
    overdue: d.stage !== 'settled' && Boolean(d.settlement_date) && d.settlement_date < now,
    owner_name: d.owner_name,
    commission: commission?.net ?? null,
    commission_upfront: commission?.upfront ?? null,
    referral_fee: commission?.referral_fee ?? null,
    commission_status: commission?.status ?? null,
  };
}

const sum = (rows, key) => round2(rows.reduce((s, r) => s + (r[key] || 0), 0));

function report({ fy = null, ownerId = null } = {}) {
  const now = today();
  const year = Number(fy) || fyOf(now);
  const { from, to } = fyRange(year);
  const ownerSql = ownerId ? ' AND d.owner_id = ?' : '';
  const ownerArgs = ownerId ? [ownerId] : [];

  const deals = db.all(
    `${DEAL_SQL} WHERE d.settlement_date IS NOT NULL AND substr(d.settlement_date, 1, 7) BETWEEN ? AND ?
       AND d.stage != 'lost'${ownerSql} ORDER BY d.settlement_date, d.id`,
    from, to, ...ownerArgs,
  ).map((d) => shape(d, now));

  let runningVolume = 0;
  let runningCommission = 0;
  const target = Number(db.getSetting('monthly_settlement_target', 0)) || 0;
  const months = monthsBetween(from, to).map((month) => {
    const rows = deals.filter((d) => d.settlement_date.slice(0, 7) === month);
    const settled = rows.filter((d) => d.settled);
    const expected = rows.filter((d) => !d.settled);
    runningVolume += sum(settled, 'loan_amount') + sum(expected, 'loan_amount');
    runningCommission += sum(settled, 'commission') + sum(expected, 'commission');
    return {
      month,
      current: month === now.slice(0, 7),
      past: month < now.slice(0, 7),
      settled,
      expected,
      totals: {
        settled_count: settled.length,
        settled_volume: sum(settled, 'loan_amount'),
        settled_commission: sum(settled, 'commission'),
        expected_count: expected.length,
        expected_volume: sum(expected, 'loan_amount'),
        expected_commission: sum(expected, 'commission'),
        overdue_count: expected.filter((d) => d.overdue).length,
      },
      running_volume: round2(runningVolume),
      running_commission: round2(runningCommission),
      running_target: target ? target * (monthsBetween(from, month).length) : null,
    };
  });

  // Open deals well along the pipeline but with no settlement date yet.
  const undated = db.all(
    `${DEAL_SQL} WHERE d.settlement_date IS NULL AND d.stage IN (${LATE_STAGES.map(() => '?').join(',')})${ownerSql}
     ORDER BY CASE d.stage ${LATE_STAGES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} END DESC, d.id`,
    ...LATE_STAGES, ...ownerArgs,
  ).map((d) => shape(d, now));

  const settledAll = deals.filter((d) => d.settled);
  const expectedAll = deals.filter((d) => !d.settled);
  const years = db.all("SELECT DISTINCT settlement_date AS d FROM deals WHERE settlement_date IS NOT NULL AND stage != 'lost'").map((r) => fyOf(r.d));
  const fyOptions = [...new Set([...years, fyOf(now), fyOf(now) + 1])].sort((a, b) => b - a).map((y) => ({ fy: y, label: fyLabel(y) }));

  return {
    fy: year,
    fy_label: fyLabel(year),
    fy_options: fyOptions,
    from,
    to,
    today: now,
    monthly_target: target || null,
    months,
    undated,
    totals: {
      settled_count: settledAll.length,
      settled_volume: sum(settledAll, 'loan_amount'),
      settled_commission: sum(settledAll, 'commission'),
      commission_received: sum(settledAll.filter((d) => d.commission_status === 'received'), 'commission'),
      expected_count: expectedAll.length,
      expected_volume: sum(expectedAll, 'loan_amount'),
      expected_commission: sum(expectedAll, 'commission'),
      overdue_count: expectedAll.filter((d) => d.overdue).length,
      undated_count: undated.length,
      undated_volume: sum(undated, 'loan_amount'),
      year_target: target ? target * 12 : null,
    },
  };
}

// Flat rows for the CSV export.
function csvRows(r) {
  const out = [];
  const row = (month, d) => ({
    Month: month, Status: d.settled ? 'Settled' : d.overdue ? 'Expected (overdue)' : 'Expected', 'Settlement date': d.settlement_date || '',
    Client: d.client, Lender: d.lender_name || '', 'Loan type': d.loan_type, 'Rate type': d.rate_type || '', 'Loan amount': d.loan_amount,
    'Upfront commission': d.commission_upfront ?? '', 'Referral fee': d.referral_fee ?? '', 'Net commission': d.commission ?? '',
    'Commission status': d.commission_status || '', Stage: d.stage_label, Broker: d.owner_name || '', Deal: d.title,
  });
  for (const m of r.months) for (const d of [...m.settled, ...m.expected]) out.push(row(m.month, d));
  for (const d of r.undated) out.push(row('No date yet', d));
  return out;
}

module.exports = { report, csvRows, fyOf };
