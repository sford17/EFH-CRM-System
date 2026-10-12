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

const { today, addDays } = require('../src/util');
let client;
let home;
let unit;

test('settling a deal adds its loan, property and value to the tracker', async () => {
  client = (await api.post('/contacts', { first_name: 'Tess', last_name: 'Tracker', email: 'tess@example.com', status: 'client' })).data;
  const lender = db.one("SELECT id FROM lenders WHERE name = 'Westpac'");
  const deal = (await api.post('/deals', {
    contact_id: client.id, loan_purpose: 'purchase', property_address: '12 Harbour St, Manly NSW 2095', property_value: 1000000, loan_amount: 700000,
    lender_id: lender.id, interest_rate: 5.79, rate_type: 'fixed', fixed_expiry_date: addDays(today(), 400), application_ref: 'WBC-1',
  })).data;
  await api.post(`/deals/${deal.id}/stage`, { stage: 'settled', settlement_date: '2024-06-01' });
  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  assert.equal(s.properties.length, 1);
  home = s.properties[0];
  assert.equal(home.address, '12 Harbour St, Manly NSW 2095');
  assert.equal(home.purchase_price, 1000000);
  assert.equal(home.valuations[0].method, 'contract_price');
  assert.equal(s.loans.length, 1);
  assert.equal(s.loans[0].lender_display, 'Westpac');
  assert.equal(s.loans[0].balance, 700000);
  assert.equal(s.loans[0].fixed_expiry_date, addDays(today(), 400));
  assert.deepEqual(s.loans[0].security_ids, [home.id]);
  assert.equal(s.totals.lvr, 70);
  // Calling again doesn't duplicate.
  require('../src/services/tracker').createFromDeal(deal.id);
  assert.equal((await api.get(`/tracker/contacts/${client.id}`)).data.loans.length, 1);
});

test('valuations are tracked by method with history and change', async () => {
  assert.equal((await api.post(`/tracker/properties/${home.id}/valuations`, { valuation_date: '2025-06-01', amount: 0, method: 'avm' })).status, 400);
  assert.equal((await api.post(`/tracker/properties/${home.id}/valuations`, { valuation_date: '2025-06-01', amount: 1, method: 'guess' })).status, 400);
  await api.post(`/tracker/properties/${home.id}/valuations`, { valuation_date: '2025-06-01', amount: 1080000, method: 'avm', provider: 'CoreLogic' });
  await api.post(`/tracker/properties/${home.id}/valuations`, { valuation_date: '2026-03-01', amount: 1150000, method: 'desktop', provider: 'Westpac' });
  await api.post(`/tracker/properties/${home.id}/valuations`, { valuation_date: '2026-09-01', amount: 1200000, method: 'avm', provider: 'CoreLogic' });
  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  home = s.properties[0];
  assert.equal(home.current_value, 1200000, 'latest valuation is the current value');
  assert.deepEqual(home.valuations.map((v) => v.method), ['avm', 'desktop', 'avm', 'contract_price']);
  assert.equal(home.valuations[0].change, 50000);
  assert.equal(home.valuations[0].change_pct, 4.3);
  assert.deepEqual(home.latest_by_method.map((v) => [v.method, v.amount]), [['avm', 1200000], ['desktop', 1150000], ['contract_price', 1000000]]);
  const avms = (await api.get('/tracker/valuations?method=avm')).data.rows;
  assert.equal(avms.length, 2);
  assert.equal(avms[0].contact_name, 'Tess Tracker');
});

test('lending structure: cross-collateralisation, unsecured debt, LVR and usable equity', async () => {
  unit = (await api.post('/tracker/properties', {
    contact_id: client.id, address: '4/20 Beach Rd, Bondi NSW', property_type: 'unit', usage: 'investment', rental_income_weekly: 650,
    valuation: { amount: 800000, method: 'agent_appraisal' },
  })).data;
  const nab = db.one("SELECT id FROM lenders WHERE name = 'NAB'");
  // Investment loan secured by BOTH properties (cross-collateralised).
  await api.post('/tracker/loans', {
    contact_id: client.id, lender_id: nab.id, loan_type: 'investment_loan', limit_amount: 600000, balance: 600000, interest_rate: 6.1,
    repayment_type: 'io', io_expiry_date: addDays(today(), 60), security_ids: [home.id, unit.id], offset_balance: 20000,
  });
  await api.post('/tracker/loans', { contact_id: client.id, lender_name: 'Latitude', loan_type: 'credit_card', limit_amount: 15000, balance: 4000 });
  await api.post('/tracker/assets', { contact_id: client.id, asset_type: 'superannuation', institution: 'AustralianSuper', value: 180000 });
  assert.equal((await api.post('/tracker/loans', { contact_id: client.id, loan_type: 'car' })).status, 400, 'lender required');

  const other = (await api.post('/contacts', { first_name: 'Other', status: 'client' })).data;
  const otherProp = (await api.post('/tracker/properties', { contact_id: other.id, address: '1 Elsewhere St' })).data;
  assert.equal((await api.post('/tracker/loans', { contact_id: client.id, lender_name: 'X', security_ids: [otherProp.id] })).status, 400);

  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  const t = s.totals;
  assert.equal(t.property_value, 2000000);
  assert.equal(t.secured_debt, 1300000);
  assert.equal(t.unsecured_debt, 4000);
  assert.equal(t.lvr, 65);
  assert.equal(t.offsets, 20000);
  assert.equal(t.other_assets, 180000);
  assert.equal(t.net_position, 2000000 + 180000 + 20000 - 1304000);

  const props = Object.fromEntries(s.structure.properties.map((p) => [p.address.slice(0, 2), p]));
  // NAB's $600k is split by value: home 1.2m (60%) → 360k, unit 800k (40%) → 240k.
  assert.equal(props['12'].secured_debt, 700000 + 360000);
  assert.equal(props['4/'].secured_debt, 240000);
  assert.equal(props['12'].lvr, 88.3);
  assert.equal(props['12'].usable_equity, 0, 'over 80%: no usable equity');
  assert.equal(props['4/'].usable_equity, 800000 * 0.8 - 240000);
  assert.equal(props['12'].multiple_lenders, true);
  assert.deepEqual(s.structure.lenders.map((l) => l.name).sort(), ['Latitude', 'NAB', 'Westpac']);
  const nabLoan = s.structure.lenders.find((l) => l.name === 'NAB').loans[0];
  assert.equal(nabLoan.cross_collateralised, true);
  assert.equal(s.structure.lenders.find((l) => l.name === 'Latitude').loans[0].unsecured, true);
  const w = s.structure.warnings.join('\n');
  assert.match(w, /NAB loan is cross-collateralised over 2 properties/);
  assert.match(w, /12 Harbour St.* secures loans with more than one lender/);
  assert.match(w, /12 Harbour St.* is at 88\.3% LVR/);
});

test('reminders run from tracker loans: interest-only and fixed-rate expiry', async () => {
  const results = (await api.post('/automations/run-scheduled')).data.results;
  const io = results.find((r) => r.automation === 'Interest-only period ending in 90 days');
  assert.ok(io, 'IO expiry automation fired');
  assert.match(io.entity, /^loan:/);
  const task = db.one("SELECT title FROM tasks WHERE title LIKE 'Interest-only ending: Tess Tracker%'");
  assert.match(task.title, /\(NAB, \d+ \w+ \d{4}\) – review repayments/);

  // A loan arranged elsewhere, refixed — no deal at all.
  const loan = (await api.post('/tracker/loans', {
    contact_id: client.id, lender_name: 'Credit Union SA', rate_type: 'fixed', fixed_expiry_date: addDays(today(), 30), balance: 200000, arranged_by_us: 0,
  })).data;
  await api.patch(`/contacts/${client.id}`, { email: 'tess@example.com' });
  const r2 = (await api.post('/automations/run-scheduled')).data.results;
  assert.ok(r2.some((r) => r.entity === `loan:${loan.id}` && r.automation === 'Fixed rate expiring in 90 days'));
  const email = db.one("SELECT subject, body FROM outbox WHERE subject LIKE 'Your fixed rate ends on%' ORDER BY id DESC");
  assert.match(email.body, /Your fixed rate with Credit Union SA ends on/);
});

test('upgrading copies settled deals into the tracker and keeps reminder history', () => {
  const migrations = require('../src/db/migrations');
  const contact = db.insert('contacts', { first_name: 'Old', status: 'client' });
  const dealId = db.insert('deals', { title: 'Old loan', contact_id: contact, stage: 'settled', loan_amount: 300000, rate_type: 'fixed', fixed_expiry_date: addDays(today(), 20), property_address: '9 Old Rd', property_value: 500000, settlement_date: '2021-01-01' });
  const auto = db.one("SELECT id FROM automations WHERE trigger = 'schedule.fixed_rate_expiry'");
  db.insert('automation_runs', { automation_id: auto.id, run_key: `${auto.id}:deal:${dealId}:${addDays(today(), 20)}`, status: 'success' });
  // Templates as they were before the tracker.
  db.run("UPDATE email_templates SET subject = 'Your fixed rate ends on {{deal.fixed_expiry_date|date}}' WHERE name = 'Fixed rate expiry review'");
  migrations.addTrackerDefaults(db);
  const loan = db.one('SELECT * FROM loans WHERE deal_id = ?', dealId);
  assert.ok(loan);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM properties WHERE contact_id = ?', contact).n, 1);
  assert.ok(db.one('SELECT 1 AS x FROM automation_runs WHERE run_key = ?', `${auto.id}:loan:${loan.id}:${addDays(today(), 20)}`), 'already-sent reminder not repeated');
  assert.equal(db.one("SELECT subject FROM email_templates WHERE name = 'Fixed rate expiry review'").subject, 'Your fixed rate ends on {{loan.fixed_expiry_date|date}}');
});

test('deleting a property removes it from loan securities; deleting the contact removes everything', async () => {
  await api.del(`/tracker/properties/${unit.id}`);
  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  assert.deepEqual(s.loans.find((n) => n.loan_type === 'investment_loan').security_ids, [home.id]);
  await api.del(`/contacts/${client.id}`);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM loans WHERE contact_id = ?', client.id).n, 0);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM properties WHERE contact_id = ?', client.id).n, 0);
});
