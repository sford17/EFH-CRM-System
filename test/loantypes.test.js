'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let db;
let api;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
});
after(() => srv.close());

const ids = {};
test('each deal has a loan type, defaulting from its purpose', async () => {
  const c = (await api.post('/contacts', { first_name: 'Lena', last_name: 'Types' })).data;
  ids.contact = c.id;
  const make = async (body) => (await api.post('/deals', { contact_id: c.id, ...body })).data;
  ids.home = (await make({ loan_purpose: 'refinance', loan_amount: 600000 })).id;
  ids.home2 = (await make({ loan_purpose: 'purchase', loan_amount: 400000 })).id;
  ids.commercial = (await make({ loan_purpose: 'commercial', loan_amount: 1000000 })).id;
  ids.smsf = (await make({ loan_purpose: 'investment', loan_type: 'smsf', loan_amount: 500000 })).id;
  ids.open = (await make({ loan_purpose: 'purchase', loan_type: 'business_loan', loan_amount: 150000 })).id;
  const types = Object.fromEntries(db.all('SELECT id, loan_type FROM deals').map((d) => [d.id, d.loan_type]));
  assert.deepEqual([types[ids.home], types[ids.commercial], types[ids.smsf], types[ids.open]], ['home_loan', 'commercial', 'smsf', 'business_loan']);
  assert.equal((await api.post('/deals', { contact_id: c.id, loan_type: 'yacht' })).status, 400);
  assert.equal((await api.patch(`/deals/${ids.home2}`, { loan_type: 'boat' })).status, 400);
  // Added some other way (import, fact find…): the purpose decides.
  const raw = db.insert('deals', { title: 'raw', contact_id: c.id, loan_purpose: 'construction' });
  assert.equal(db.one('SELECT loan_type FROM deals WHERE id = ?', raw).loan_type, 'construction');
  db.run('DELETE FROM deals WHERE id = ?', raw);
});

test('the Loan types report: settled by type, month by month, pipeline and loan book', async () => {
  const settle = (id, date) => api.post(`/deals/${id}/stage`, { stage: 'settled', settlement_date: date });
  await settle(ids.home, '2026-08-10');
  await settle(ids.home2, '2026-09-03');
  await settle(ids.commercial, '2026-08-20');
  await settle(ids.smsf, '2026-09-15');
  const r = (await api.get('/reports/loan-types?period=custom&from=2026-07-01&to=2026-12-31')).data;
  assert.deepEqual(r.types.map((t) => [t.label, t.count, t.volume, t.share, t.average]), [
    ['Home loan', 2, 1000000, 40, 500000],
    ['Commercial loan', 1, 1000000, 40, 1000000],
    ['SMSF loan', 1, 500000, 20, 500000],
  ]);
  assert.deepEqual([r.totals.count, r.totals.volume], [4, 2500000]);
  const aug = r.months.find((m) => m.month === '2026-08');
  assert.deepEqual([aug.count, aug.volume, aug.by.home_loan.count, aug.by.commercial.volume, aug.by.smsf.count], [2, 1600000, 1, 1000000, 0]);
  assert.equal(r.months.length, 6);
  assert.deepEqual(r.pipeline.map((t) => [t.label, t.count, t.volume]), [['Business loan', 1, 150000]]);
  assert.deepEqual(r.book.map((t) => t.label).sort(), ['Commercial loan', 'Home loan', 'SMSF loan'], 'settled loans are on the trackers');
  assert.equal(db.one('SELECT loan_type FROM loans WHERE deal_id = ?', ids.smsf).loan_type, 'smsf');
  // Another period, and one broker only.
  assert.equal((await api.get('/reports/loan-types?period=custom&from=2025-01-01&to=2025-12-31')).data.totals.count, 0);
  assert.equal((await api.get('/reports/loan-types?period=custom&from=2026-07-01&to=2026-12-31&owner_id=999')).data.totals.count, 0);

  const csv = await api.get('/reports/loan-types.csv?period=custom&from=2026-07-01&to=2026-12-31');
  const lines = csv.data.split('\r\n');
  assert.equal(lines[0], 'Settlement date,Loan type,Purpose,Client,Deal,Lender,Loan amount,Commission,Broker');
  assert.equal(lines.length, 5);
  assert.match(lines.find((l) => l.includes('SMSF')), /^2026-09-15,SMSF loan,investment,Lena Types,/);
  // The settlements report names the type too.
  const s = (await api.get('/reports/settlements?period=custom&from=2026-07-01&to=2026-12-31')).data;
  const all = s.months.flatMap((m) => m.settled);
  assert.ok(all.some((d) => d.loan_type === 'Home loan · Refinance'));
  assert.ok(all.some((d) => d.loan_type === 'Commercial loan'));
});
