'use strict';
// Reporting periods: Australian financial years (July–June), calendar years,
// or any custom date range.
const db = require('../db');
const { today, formatDate, daysBetween } = require('../util');
const { HttpError } = require('../util');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;
const MAX_DAYS = 366 * 10;

// FY2027 = 1 July 2026 to 30 June 2027.
function fyOf(date) {
  const y = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 7 ? y + 1 : y;
}

const validDate = (d) => DATE.test(d || '') && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

// From query params { period: 'fy'|'cy'|'custom', fy, year, from, to }.
// Defaults to the current financial year. Plain from/to (as used before
// periods existed) count as a custom range.
function resolve(q = {}) {
  const now = today();
  let type = ['fy', 'cy', 'custom'].includes(q.period) ? q.period : (q.from || q.to) && !q.period ? 'custom' : 'fy';
  if (type === 'custom') {
    const from = q.from || '';
    const to = q.to || '';
    if (!validDate(from) || !validDate(to)) throw new HttpError(400, 'Choose a start and end date for the custom period');
    if (from > to) throw new HttpError(400, 'The start date is after the end date');
    if (daysBetween(from, to) > MAX_DAYS) throw new HttpError(400, 'Choose a period of 10 years or less');
    return { type, from, to, label: `${formatDate(from)} – ${formatDate(to)}`, short: 'this period' };
  }
  if (type === 'cy') {
    const year = YEAR.test(q.year || '') ? Number(q.year) : Number(now.slice(0, 4));
    return { type, year, from: `${year}-01-01`, to: `${year}-12-31`, label: `${year} (Jan – Dec)`, short: String(year) };
  }
  type = 'fy';
  const fy = YEAR.test(String(q.fy || '')) ? Number(q.fy) : fyOf(now);
  return { type, fy, from: `${fy - 1}-07-01`, to: `${fy}-06-30`, label: `FY${String(fy).slice(2)} (Jul ${fy - 1} – Jun ${fy})`, short: `FY${String(fy).slice(2)}` };
}

// Years with deals in them (plus this year and next), newest first, for the pickers.
function yearOptions() {
  const now = today();
  const dates = db.all(
    `SELECT MIN(d) AS first FROM (SELECT MIN(settlement_date) AS d FROM deals WHERE settlement_date IS NOT NULL
     UNION ALL SELECT MIN(substr(created_at,1,10)) FROM deals)`,
  )[0]?.first || now;
  const firstYear = Math.min(Number(dates.slice(0, 4)), Number(now.slice(0, 4)));
  const years = [];
  for (let y = Number(now.slice(0, 4)) + 1; y >= firstYear; y--) years.push(y);
  const fys = [];
  for (let y = fyOf(now) + 1; y >= fyOf(dates < now ? dates : now); y--) fys.push(y);
  return {
    fy: fys.map((y) => ({ value: y, label: `FY${String(y).slice(2)} (Jul ${y - 1} – Jun ${y})`, current: y === fyOf(now) })),
    cy: years.map((y) => ({ value: y, label: String(y), current: y === Number(now.slice(0, 4)) })),
  };
}

module.exports = { resolve, yearOptions, fyOf };
