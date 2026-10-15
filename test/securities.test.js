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
test('rent roll, GSA and guarantee on a business loan deal', async () => {
  ids.mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones' })).data.id;
  ids.co = (await api.post('/contacts', { entity_type: 'company', first_name: 'Harbour Realty Pty Ltd' })).data.id;
  ids.deal = (await api.post('/deals', { contact_id: ids.co, loan_purpose: 'business_loan', loan_amount: 900000, co_borrower_ids: [] })).data.id;
  ids.home = (await api.post('/deals', { contact_id: ids.mia, loan_purpose: 'purchase' })).data.id;
  const add = (body) => api.post('/tracker/securities', body);

  assert.equal((await add({ deal_id: ids.home, type: 'gsa', contact_id: ids.co })).status, 400, 'home loans: property only');
  assert.equal((await add({ deal_id: ids.deal, type: 'mortgage' })).status, 400);
  assert.equal((await add({ deal_id: ids.deal, type: 'guarantee' })).status, 400, 'a guarantee needs a guarantor');
  assert.equal((await add({ deal_id: ids.deal, loan_id: 1, type: 'rent_roll' })).status, 400, 'deal or loan, not both');

  const rr = await add({ deal_id: ids.deal, type: 'rent_roll', name: 'Harbour Realty rent roll', managements: '412', value: 1500000 });
  assert.equal(rr.status, 201, JSON.stringify(rr.data));
  assert.equal(rr.data.summary, 'Rent roll – Harbour Realty rent roll (412 managements, $1.5m)');
  const gsa = (await add({ deal_id: ids.deal, type: 'gsa', contact_id: ids.co, description: 'All present and after-acquired property', ppsr_number: '201908150012345' })).data;
  assert.equal(gsa.summary, 'GSA – Harbour Realty Pty Ltd');
  const g = (await add({ deal_id: ids.deal, type: 'guarantee', contact_id: ids.mia, limit_amount: 250000, description: 'Director\'s guarantee' })).data;
  assert.equal(g.summary, 'Guarantee – Mia Jones (limit $250k)');
  assert.equal((await api.patch(`/tracker/securities/${g.id}`, { limit_amount: '' })).data.summary, 'Guarantee – Mia Jones (unlimited)');
  assert.equal((await api.patch(`/tracker/securities/${g.id}`, { value: -5 })).status, 400);

  // A company with no directors linked yet: the deal's Quickli section explains rather than failing.
  const q = await api.get(`/deals/${ids.deal}/quickli`);
  assert.equal(q.status, 200);
  assert.match(q.data.blocked, /directors/);
  const deal = (await api.get(`/deals/${ids.deal}`)).data;
  assert.deepEqual(deal.other_securities.map((s) => s.type), ['rent_roll', 'gsa', 'guarantee']);
  assert.equal(deal.other_securities[0].label, 'Rent roll');
});

test('at settlement they move to the loan, and show in the tracker and lending review', async () => {
  await api.post(`/deals/${ids.deal}/stage`, { stage: 'settled', settlement_date: '2026-10-01' });
  const loan = db.one('SELECT id, loan_type FROM loans WHERE deal_id = ?', ids.deal);
  assert.equal(loan.loan_type, 'business_loan');
  const t = (await api.get(`/tracker/contacts/${ids.co}`)).data;
  const n = t.loans.find((x) => x.id === loan.id);
  assert.deepEqual(n.other_securities.map((s) => s.summary), [
    'Rent roll – Harbour Realty rent roll (412 managements, $1.5m)', 'GSA – Harbour Realty Pty Ltd', 'Guarantee – Mia Jones (unlimited)',
  ]);
  // Copied once only.
  require('../src/services/securities').copyDealToLoan(ids.deal, loan.id);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM other_securities WHERE loan_id = ?', loan.id).n, 3);
  // Added straight onto a tracker loan.
  const extra = await api.post('/tracker/securities', { loan_id: loan.id, type: 'guarantee', name: 'Tom Jones', limit_amount: 100000 });
  assert.equal(extra.status, 201);
  assert.equal((await api.del(`/tracker/securities/${extra.data.id}`)).status, 200);

  const rev = (await api.post('/reviews', { contact_id: ids.co })).data;
  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${srv.base}/reviews/${rev.id}/preview`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /Rent roll – Harbour Realty rent roll \(412 managements, \$1\.5m\)<br>GSA – Harbour Realty Pty Ltd<br>Guarantee – Mia Jones \(unlimited\)/);
  // Deleting the deal's guarantor keeps the security, with no name.
  db.run('DELETE FROM contacts WHERE id = ?', ids.mia);
  assert.equal(require('../src/services/securities').forLoan(loan.id).find((s) => s.type === 'guarantee').summary, 'Guarantee (unlimited)');
});
