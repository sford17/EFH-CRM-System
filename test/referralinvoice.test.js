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
  db.setSetting('business_name', 'EFH Mortgage Broking');
});
after(() => srv.close());

const ids = {};
test('setup: a settled deal referred by a partner who gets 10%', async () => {
  ids.lender = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  db.run('UPDATE lenders SET upfront_pct = 0.65 WHERE id = ?', ids.lender);
  ids.partner = (await api.post('/partners', { name: 'Alex Morgan', company: 'Harbourside Realty', type: 'real_estate', email: 'alex@harbourside.test', referral_fee_pct: 10 })).data.id;
  const mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones' })).data.id;
  const tom = (await api.post('/contacts', { first_name: 'Tom', last_name: 'Jones' })).data.id;
  ids.deal = (await api.post('/deals', { contact_id: mia, co_borrower_ids: [tom], loan_amount: 500000, lender_id: ids.lender, referral_partner_id: ids.partner })).data.id;
  let d = (await api.get(`/deals/${ids.deal}`)).data;
  assert.equal(d.referral_invoice.applies, true);
  assert.equal(d.referral_invoice.settled, false, 'not until settlement');
  await api.post(`/deals/${ids.deal}/stage`, { stage: 'settled', settlement_date: '2026-10-14' });
  d = (await api.get(`/deals/${ids.deal}`)).data;
  assert.deepEqual([d.referral_invoice.settled, d.referral_invoice.figures.fee_ex_gst, d.referral_invoice.figures.gst, d.referral_invoice.figures.fee_inc_gst], [true, 325, 32.5, 357.5]);
});

test('the email names the client, the loan and the fee including GST', async () => {
  const r = (await api.get(`/deals/${ids.deal}/referral-invoice`)).data;
  assert.equal(r.to, 'alex@harbourside.test');
  assert.equal(r.subject, 'Referral fee invoice: Mia Jones and Tom Jones');
  for (const s of ['Hi Alex,', 'Client: Mia Jones and Tom Jones', 'Loan amount: $500,000', 'Lender: Westpac', 'Settled: 14 October 2026',
    'Referral fee: $325.00 + GST $32.50 = $357.50 (including GST)', 'tax invoice', 'EFH Mortgage Broking', 'ABN and bank details']) {
    assert.ok(r.body.includes(s), `body has ${s}`);
  }
  // A corrected amount.
  const changed = (await api.get(`/deals/${ids.deal}/referral-invoice?fee_ex_gst=400`)).data;
  assert.match(changed.body, /\$400\.00 \+ GST \$40\.00 = \$440\.00/);
  assert.equal((await api.get(`/deals/${ids.deal}/referral-invoice?fee_ex_gst=-3`)).status, 400);
});

test('sending emails the partner and records the request', async () => {
  const r = await api.post(`/deals/${ids.deal}/referral-invoice`, { subject: 'Invoice please', body: 'Hi Alex, please invoice us $357.50.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'logged', 'no Outlook or SMTP in tests');
  const mail = db.one('SELECT * FROM outbox WHERE id = ?', r.data.outbox_id);
  assert.deepEqual([mail.to_email, mail.subject, mail.partner_id, mail.deal_id, mail.contact_id], ['alex@harbourside.test', 'Invoice please', ids.partner, ids.deal, null]);
  assert.ok(db.one("SELECT invoice_requested_at FROM commissions WHERE deal_id = ? AND type = 'referral_fee'", ids.deal).invoice_requested_at);
  assert.ok((await api.get(`/deals/${ids.deal}`)).data.referral_invoice.requested_at);
  assert.match(db.one("SELECT body FROM activities WHERE deal_id = ? AND body LIKE 'Referral fee invoice requested%'", ids.deal).body, /Alex Morgan \(Harbourside Realty\): \$325\.00 \+ GST/);
  assert.ok((await api.get('/commissions?type=referral_fee')).data.rows[0].invoice_requested_at);
});

test('partners not registered for GST, with no email, or with no fee', async () => {
  await api.patch(`/partners/${ids.partner}`, { gst_registered: 0 });
  assert.match((await api.get(`/deals/${ids.deal}/referral-invoice`)).data.body, /Referral fee: \$325\.00 \(no GST: you're not registered for GST\)/);
  await api.patch(`/partners/${ids.partner}`, { email: null });
  assert.equal((await api.post(`/deals/${ids.deal}/referral-invoice`, {})).status, 400);
  const other = (await api.post('/partners', { name: 'No Fee', type: 'accountant', email: 'nf@x.test', referral_fee_pct: 0 })).data.id;
  const c = (await api.post('/contacts', { first_name: 'Ava' })).data.id;
  const d = (await api.post('/deals', { contact_id: c, loan_amount: 300000, lender_id: ids.lender, referral_partner_id: other })).data.id;
  assert.equal((await api.get(`/deals/${d}`)).data.referral_invoice.applies, false);
  assert.equal((await api.get(`/deals/${d}/referral-invoice`)).status, 400);
});
