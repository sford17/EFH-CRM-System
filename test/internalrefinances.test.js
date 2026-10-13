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

const { today, addMonths } = require('../src/util');
const { monthsBetween } = require('../src/services/internalRefinances');
const T = today();
let mia;
let tom;
let oldDeal;
let refiDeal;
let wbc;
let anz;

test('months held counts whole months', () => {
  assert.equal(monthsBetween('2025-03-15', '2026-03-14'), 11);
  assert.equal(monthsBetween('2025-03-15', '2026-03-15'), 12);
  assert.equal(monthsBetween('2026-03-15', '2025-03-15'), null);
  assert.equal(monthsBetween(null, '2026-01-01'), null);
});

test('setup: a loan we wrote 10 months ago with Westpac', async () => {
  wbc = db.one("SELECT id, clawback_months FROM lenders WHERE name = 'Westpac'");
  anz = db.one("SELECT id FROM lenders WHERE name = 'ANZ'").id;
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones' })).data;
  tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom' }, relationship: 'spouse', shared_finances: 1 })).data;
  oldDeal = (await api.post('/deals', {
    contact_id: mia.id, co_borrower_id: tom.related_id, lender_id: wbc.id, loan_purpose: 'purchase', loan_amount: 600000,
    interest_rate: 6.19, product_name: 'Flexi First', application_ref: 'WBC-111', property_address: '1 Smith St, Sydney NSW 2000',
    settlement_date: addMonths(T, -10),
  })).data;
  await api.post(`/deals/${oldDeal.id}/stage`, { stage: 'settled' });
  assert.equal(db.one('SELECT status FROM loans WHERE deal_id = ?', oldDeal.id).status, 'active');
});

test('the client picker prefills both sides from loans and deals', async () => {
  const o = (await api.get(`/refinances/options/${tom.related_id}`)).data;
  assert.equal(o.client_name, 'Tom & Mia Jones', 'the chosen person first');
  const loan = o.loans.find((l) => l.old.old_account_number === 'WBC-111');
  assert.ok(loan, 'household loan offered for the partner too');
  assert.equal(loan.old.old_lender_name, 'Westpac');
  assert.equal(loan.old.old_borrowers, 'Mia Jones & Tom Jones');
  assert.equal(loan.old.old_loan_amount, 600000);
  assert.equal(loan.old.old_settlement_date, addMonths(T, -10));
  assert.ok(o.deals.some((d) => d.new.new_deal_id === oldDeal.id));
  assert.equal((await api.get('/refinances/options/99999')).status, 404);
});

test('settling a refinance to another lender records it for review', async () => {
  refiDeal = (await api.post('/deals', {
    contact_id: mia.id, co_borrower_id: tom.related_id, lender_id: anz, loan_purpose: 'refinance', loan_amount: 650000,
    interest_rate: 5.79, rate_type: 'fixed', product_name: 'Simplicity PLUS', application_ref: 'ANZ-222', property_address: '1 Smith St, Sydney NSW 2000',
    settlement_date: T,
  })).data;
  await api.post(`/deals/${refiDeal.id}/stage`, { stage: 'settled' });
  const r = (await api.get('/refinances')).data;
  assert.equal(r.rows.length, 1);
  const e = r.rows[0];
  assert.equal(e.status, 'needs_review');
  assert.equal(e.source, 'auto');
  assert.equal(e.client_name, 'Mia & Tom Jones');
  assert.deepEqual([e.old_lender_name, e.old_account_number, e.old_loan_amount, e.old_discharge_date], ['Westpac', 'WBC-111', 600000, T]);
  assert.deepEqual([e.new_lender_name, e.new_account_number, e.new_loan_amount, e.new_rate_type, e.new_settlement_date], ['ANZ', 'ANZ-222', 650000, 'fixed', T]);
  assert.equal(e.new_deal_id, refiDeal.id);
  assert.ok(e.new_loan_id, 'linked to the new tracker loan');
  assert.equal(e.months_held, 10);
  assert.equal(e.within_clawback, wbc.clawback_months > 10);
  assert.equal(e.old_upfront_commission > 0, true, 'upfront on the old loan from the ledger');
  assert.equal(e.increase, 50000);
  assert.equal(r.totals.needs_review_count, 1);
  assert.deepEqual(r.flows.map((f) => [f.from, f.to, f.count]), [['Westpac', 'ANZ', 1]]);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'Internal refinance recorded for Mia Jones: Westpac → ANZ%'"));

  // Moving the deal back and forward doesn't log it twice.
  await api.post(`/deals/${refiDeal.id}/stage`, { stage: 'settlement_booked' });
  await api.post(`/deals/${refiDeal.id}/stage`, { stage: 'settled' });
  assert.equal(db.one('SELECT COUNT(*) AS n FROM internal_refinances').n, 1);
});

test('every field can be edited, and completing it can mark the old loan refinanced', async () => {
  const id = (await api.get('/refinances')).data.rows[0].id;
  const res = await api.put(`/refinances/${id}`, {
    status: 'completed', reason: 'Better rate', old_balance: '$585,000', old_interest_rate: '6.19', clawback_amount: 1950, cashback: 2000,
    old_account_number: 'WBC-111-A', new_product: 'Fixed 2 years', mark_old_refinanced: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'completed');
  assert.equal(res.data.old_balance, 585000);
  assert.equal(res.data.new_product, 'Fixed 2 years');
  assert.equal(res.data.increase, 65000);
  assert.equal(db.one('SELECT status FROM loans WHERE deal_id = ?', oldDeal.id).status, 'refinanced');
  for (const bad of [{ old_settlement_date: '13/02/2024' }, { new_loan_amount: 'lots' }, { status: 'done' }, { client_name: '' }, { old_rate_type: 'tracker' }]) {
    assert.equal((await api.put(`/refinances/${id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api.put('/refinances/99999', { reason: 'x' })).status, 404);
});

test('manual entries for loans written before the CRM, filters and periods', async () => {
  const noah = (await api.post('/contacts', { first_name: 'Noah', last_name: 'Smith' })).data;
  const res = await api.post('/refinances', {
    contact_id: noah.id, old_lender_name: 'Bank of Melbourne', old_settlement_date: '2019-05-01', old_discharge_date: '2024-03-20',
    old_loan_amount: 400000, new_lender_id: anz, new_settlement_date: '2024-03-20', new_loan_amount: 380000, reason: 'Fixed rate expiry',
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.client_name, 'Noah Smith', 'name from the chosen contact');
  assert.equal(res.data.new_lender_name, 'ANZ', 'name from the chosen lender');
  assert.equal(res.data.status, 'completed');
  assert.equal(res.data.months_held, 58);
  assert.equal(res.data.within_clawback, false);
  assert.equal((await api.post('/refinances', { old_lender_name: 'X' })).status, 400, 'client needed');
  assert.equal((await api.post('/refinances', { client_name: 'Dup', new_deal_id: refiDeal.id })).status, 400, 'one entry per deal');

  const all = (await api.get('/refinances?period=all')).data;
  assert.equal(all.rows.length, 2);
  assert.equal(all.period.type, 'all');
  const fy24 = (await api.get('/refinances?period=fy&fy=2024')).data;
  assert.deepEqual(fy24.rows.map((r) => r.client_name), ['Noah Smith']);
  const current = (await api.get('/refinances')).data;
  assert.deepEqual(current.rows.map((r) => r.client_name), ['Mia & Tom Jones']);
  assert.equal((await api.get('/refinances?period=all&q=melbourne')).data.rows.length, 0, 'search is by client/borrower/account');
  assert.equal((await api.get('/refinances?period=all&q=noah')).data.rows.length, 1);
  assert.equal((await api.get(`/refinances?period=all&lender_id=${wbc.id}`)).data.rows.length, 1);
  assert.equal((await api.get(`/refinances?period=all&contact_id=${tom.related_id}`)).data.rows.length, 1, 'household entries on a contact');
  assert.equal((await api.get('/refinances?period=all&status=completed')).data.totals.completed_count, 2);

  assert.equal((await api.del(`/refinances/${res.data.id}`)).status, 204);
  assert.equal((await api.get(`/refinances/${res.data.id}`)).status, 404);
});

test('a refinance with the same lender, or with no loan of ours, is not auto-recorded', async () => {
  const zoe = (await api.post('/contacts', { first_name: 'Zoe', last_name: 'Clarke' })).data;
  const first = (await api.post('/deals', { contact_id: zoe.id, lender_id: anz, loan_purpose: 'purchase', loan_amount: 300000, settlement_date: addMonths(T, -30) })).data;
  await api.post(`/deals/${first.id}/stage`, { stage: 'settled' });
  const same = (await api.post('/deals', { contact_id: zoe.id, lender_id: anz, loan_purpose: 'refinance', loan_amount: 300000, settlement_date: T })).data;
  await api.post(`/deals/${same.id}/stage`, { stage: 'settled' });
  const liam = (await api.post('/contacts', { first_name: 'Liam', last_name: 'Wilson' })).data;
  await api.post('/tracker/loans', { contact_id: liam.id, lender_name: 'CBA', loan_type: 'home_loan', limit_amount: 500000, arranged_by_us: 0 });
  const other = (await api.post('/deals', { contact_id: liam.id, lender_id: anz, loan_purpose: 'refinance', loan_amount: 500000, settlement_date: T })).data;
  await api.post(`/deals/${other.id}/stage`, { stage: 'settled' });
  assert.equal(db.one('SELECT COUNT(*) AS n FROM internal_refinances WHERE contact_id IN (?, ?)', zoe.id, liam.id).n, 0);
});

test('CSV export for sale records', async () => {
  const cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${srv.base}/refinances.csv?period=all`, { headers: { Cookie: cookie } });
  assert.match(res.headers.get('content-disposition'), /internal-refinances-all\.csv/);
  const lines = (await res.text()).split('\r\n');
  assert.match(lines[0], /^Status,Switch date,Client,Reason,Old lender,Old borrowers,Old account,/);
  assert.ok(lines.some((l) => /^Completed,.*Mia & Tom Jones,Better rate,Westpac,Mia Jones & Tom Jones,WBC-111-A,.*ANZ,/.test(l)));
  const empty = await fetch(`${srv.base}/refinances.csv?period=fy&fy=2001`, { headers: { Cookie: cookie } });
  assert.match(await empty.text(), /^Status,Switch date,Client/, 'header row even when empty');
});
