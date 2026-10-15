'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
before(async () => {
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
});
after(() => srv.close());

test('business loans: a deal purpose that becomes a business loan on the tracker', async () => {
  const c = (await api.post('/contacts', { first_name: 'Bo', last_name: 'Biz' })).data;
  const deal = await api.post('/deals', { contact_id: c.id, loan_purpose: 'business_loan', loan_amount: 250000 });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  assert.equal(deal.data.loan_purpose, 'business_loan');
  const loanId = require('../src/services/tracker').createFromDeal(deal.data.id);
  const t = (await api.get(`/tracker/contacts/${c.id}`)).data;
  assert.equal(t.loans.find((n) => n.id === loanId).loan_type, 'business_loan');
  const added = await api.post('/tracker/loans', { contact_id: c.id, lender_name: 'Judo Bank', loan_type: 'business_loan', balance: 90000 });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal((await api.post('/tracker/loans', { contact_id: c.id, lender_name: 'X', loan_type: 'boat' })).status >= 400, true, 'unknown types still refused');
});
