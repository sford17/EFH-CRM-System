'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
let db;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => srv.close());

const { today, addDays, addMonths } = require('../src/util');
const { fyOf } = require('../src/services/settlementReport');
const T = today();
const FY = fyOf(T);
let jordan;

test('financial years run July to June', () => {
  assert.equal(fyOf('2026-06-30'), 2026);
  assert.equal(fyOf('2026-07-01'), 2027);
});

test('setup: settled, expected, overdue and undated deals', async () => {
  const wbc = db.one("SELECT id, upfront_pct FROM lenders WHERE name = 'Westpac'");
  const anz = db.one("SELECT id FROM lenders WHERE name = 'ANZ'").id;
  jordan = (await api.post('/users', { name: 'Jordan Lee', email: 'jordan@test.local', password: 'password123', role: 'broker' })).data;
  const partner = (await api.post('/partners', { name: 'Alex Agent', type: 'real_estate', referral_fee_pct: 20 })).data;
  const mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones', referral_partner_id: partner.id })).data;
  const tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom' }, relationship: 'spouse', shared_finances: 1 })).data;
  const noah = (await api.post('/contacts', { first_name: 'Noah', last_name: 'Smith' })).data;
  const zoe = (await api.post('/contacts', { first_name: 'Zoe', last_name: 'Clarke' })).data;
  const liam = (await api.post('/contacts', { first_name: 'Liam', last_name: 'Wilson' })).data;

  // Settled earlier this month: $600k at 0.65% = $3,900 upfront, less 20% referral fee = $3,120.
  const settledDay = `${T.slice(0, 7)}-01`;
  const settled = (await api.post('/deals', { contact_id: mia.id, co_borrower_id: tom.related_id, lender_id: wbc.id, loan_purpose: 'purchase', rate_type: 'fixed', loan_amount: 600000, settlement_date: settledDay })).data;
  await api.post(`/deals/${settled.id}/stage`, { stage: 'settled' });
  // Expected next month; and one overdue (date passed, not settled) for Jordan.
  await api.post('/deals', { contact_id: noah.id, lender_id: anz, loan_purpose: 'refinance', loan_amount: 400000, settlement_date: addMonths(T, 1), stage: 'settlement_booked' });
  await api.post('/deals', { contact_id: zoe.id, lender_id: wbc.id, loan_purpose: 'investment', loan_amount: 500000, settlement_date: addDays(T, -1), stage: 'unconditional_approval', owner_id: jordan.id });
  // Lodged with no date yet; and a lost deal that should never appear.
  await api.post('/deals', { contact_id: liam.id, lender_id: wbc.id, loan_amount: 900000, stage: 'application_lodged' });
  await api.post('/deals', { contact_id: liam.id, lender_id: wbc.id, loan_amount: 100000, settlement_date: addMonths(T, 1), stage: 'lost', lost_reason: 'x' });
});

test('settled and expected deals, by month, with commission', async () => {
  const r = (await api.get('/reports/settlements')).data;
  assert.equal(r.period.type, 'fy');
  assert.equal(r.period.fy, FY);
  assert.equal(r.months.length, 12);
  assert.equal(r.months[0].month, `${FY - 1}-07`);
  const thisMonth = r.months.find((m) => m.current);
  const mia = thisMonth.settled.find((d) => d.client === 'Mia Jones & Tom Jones');
  assert.ok(mia, 'joint borrowers named');
  assert.equal(mia.lender_name, 'Westpac');
  assert.equal(mia.loan_type, 'Home loan · Purchase');
  assert.equal(mia.rate_type, 'fixed');
  assert.equal(mia.loan_amount, 600000);
  assert.equal(mia.commission_upfront, 3900);
  assert.equal(mia.referral_fee, 780);
  assert.equal(mia.commission, 3120);
  assert.equal(mia.commission_status, 'expected', 'from the commission ledger, not yet received');

  const all = r.months.flatMap((m) => [...m.settled, ...m.expected]);
  const noah = all.find((d) => d.client === 'Noah Smith');
  assert.equal(noah.settled, false);
  assert.equal(noah.stage_label, 'Settlement Booked');
  assert.equal(noah.commission_status, 'estimated');
  assert.equal(noah.commission, 2600);
  const zoe = all.find((d) => d.client === 'Zoe Clarke');
  assert.equal(zoe.overdue, true);
  assert.equal(all.some((d) => d.client.startsWith('Liam')), false, 'undated and lost deals are not in a month');
  assert.deepEqual(r.undated.map((d) => [d.client, d.stage]), [['Liam Wilson', 'application_lodged']]);

  assert.equal(r.totals.settled_count, 1);
  assert.equal(r.totals.settled_commission, 3120);
  assert.equal(r.totals.overdue_count, 1);
  // Running totals add up month by month.
  const last = r.months[r.months.length - 1];
  assert.equal(last.running_volume, r.totals.settled_volume + r.totals.expected_volume);
  assert.equal(thisMonth.totals.settled_volume, 600000);
});

test('received commission is shown as received', async () => {
  db.run("UPDATE commissions SET status = 'received' WHERE type IN ('upfront','referral_fee')");
  const r = (await api.get('/reports/settlements')).data;
  const mia = r.months.find((m) => m.current).settled[0];
  assert.equal(mia.commission_status, 'received');
  assert.equal(r.totals.commission_received, 3120);
});

test('filter by broker, pick another year, and the monthly target', async () => {
  const mine = (await api.get(`/reports/settlements?owner_id=${jordan.id}`)).data;
  assert.deepEqual(mine.months.flatMap((m) => [...m.settled, ...m.expected]).map((d) => d.client), ['Zoe Clarke']);
  assert.equal(mine.undated.length, 0);
  const last = (await api.get(`/reports/settlements?period=fy&fy=${FY - 1}`)).data;
  assert.equal(last.months[0].month, `${FY - 2}-07`);
  assert.equal(last.totals.settled_count, 0);
  const options = (await api.get('/reports/periods')).data;
  assert.ok(options.fy.some((o) => o.value === FY + 1), 'next financial year offered');
  assert.ok(options.cy.some((o) => o.value === Number(T.slice(0, 4)) && o.current));
  await api.put('/settings', { monthly_settlement_target: '1000000' });
  const t = (await api.get('/reports/settlements')).data;
  assert.equal(t.totals.period_target, 12000000);
  assert.equal(t.months[2].running_target, 3000000);
});

test('calendar years and custom date ranges', async () => {
  const year = Number(T.slice(0, 4));
  const cy = (await api.get(`/reports/settlements?period=cy&year=${year}`)).data;
  assert.equal(cy.period.label, `${year} (Jan – Dec)`);
  assert.deepEqual([cy.months[0].month, cy.months.length], [`${year}-01`, 12]);
  assert.ok(cy.months.flatMap((m) => m.settled).some((d) => d.client === 'Mia Jones & Tom Jones'));

  // A custom range covering just this month: only Mia's settlement (and Zoe, if overdue this month).
  const from = `${T.slice(0, 7)}-01`;
  const custom = (await api.get(`/reports/settlements?period=custom&from=${from}&to=${T}`)).data;
  assert.equal(custom.months.length, 1);
  assert.equal(custom.totals.period_target, 1000000);
  const clients = custom.months[0].settled.map((d) => d.client);
  assert.deepEqual(clients, ['Mia Jones & Tom Jones']);
  assert.ok(custom.months[0].expected.every((d) => d.settlement_date <= T), 'nothing after the end date');

  for (const bad of ['period=custom&from=2026-05-01', `period=custom&from=${T}&to=2020-01-01`, 'period=custom&from=2026-02-30&to=2026-03-01', 'period=custom&from=2000-01-01&to=2026-01-01']) {
    assert.equal((await api.get(`/reports/settlements?${bad}`)).status, 400, bad);
  }
  // The overview report takes the same periods.
  const overview = (await api.get(`/reports?period=cy&year=${year}`)).data;
  assert.deepEqual([overview.from, overview.to], [`${year}-01-01`, `${year}-12-31`]);
  assert.equal((await api.get('/reports')).data.period.type, 'fy', 'financial year by default');
  assert.equal((await api.get(`/reports?from=${from}&to=${T}`)).data.period.type, 'custom', 'plain from/to still works');
});

test('CSV export', async () => {
  const cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const cyRes = await fetch(`${srv.base}/reports/settlements.csv?period=cy&year=2026`, { headers: { Cookie: cookie } });
  assert.match(cyRes.headers.get('content-disposition'), /settlements-2026\.csv/);
  const res = await fetch(`${srv.base}/reports/settlements.csv?fy=${FY}`, { headers: { Cookie: cookie } });
  assert.match(res.headers.get('content-disposition'), new RegExp(`settlements-FY${String(FY).slice(2)}\\.csv`));
  const text = await res.text();
  const lines = text.split('\r\n');
  assert.match(lines[0], /^Month,Status,Settlement date,Client,Lender,Loan type,Rate type,Loan amount,Upfront commission,Referral fee,Net commission,Commission status,Stage,Broker,Deal$/);
  assert.ok(lines.some((l) => /,Settled,.*Mia Jones & Tom Jones,Westpac,Home loan · Purchase,fixed,600000,3900,780,3120,received,/.test(l)));
  assert.ok(lines.some((l) => /^No date yet,Expected,,Liam Wilson,/.test(l)));
  assert.ok(lines.some((l) => /Expected \(overdue\),.*Zoe Clarke/.test(l)));
});
