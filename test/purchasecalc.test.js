'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { calculate, fromDeal } = require('../src/services/purchaseCalc');

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

test('price, loan and LVR, then costs adding up to the total contribution', () => {
  const r = calculate({ purchase_price: 850000, loan_amount: 765000, state: 'NSW', legal_costs: 2200, other_costs: [{ label: 'Building & pest', amount: 600 }] });
  assert.equal(r.lvr, 90);
  assert.equal(r.deposit_required, 85000);
  assert.equal(r.stamp_duty.amount, 32437, 'NSW general rates: 11,602 + 4.5% over 387,000');
  assert.equal(r.lmi.amount, 12240, 'indicative 1.6% for 85–90%');
  assert.equal(r.total_contribution, 85000 + 32437 + 12240 + 2200 + 600);
  assert.equal(r.max_loan_without_lmi, 680000);
});

test('LVR drives the loan, overrides replace estimates, LMI can be added to the loan', () => {
  const r = calculate({ purchase_price: '$700,000', loan_basis: 'lvr', lvr: 95, loan_amount: 1, state: 'QLD', first_home: true, property_type: 'new', lmi_capitalised: true });
  assert.equal(r.loan_amount, 665000);
  assert.equal(r.stamp_duty.amount, 0, 'QLD new home for a first home buyer');
  assert.equal(r.lmi.amount, 21280);
  assert.equal(r.lmi.payable, 0);
  assert.equal(r.total_loan, 686280);
  assert.equal(r.lvr_incl_lmi, 98.04);
  assert.equal(r.total_contribution, 35000 + 2000, 'deposit + default legal costs');

  const o = calculate({ purchase_price: 700000, loan_amount: 560000, state: 'QLD', stamp_duty: 15000, lmi: 0, legal_costs: 0, funds_available: 100000 });
  assert.equal(o.stamp_duty.overridden, true);
  assert.ok(o.stamp_duty.auto_amount > 0);
  assert.equal(o.total_contribution, 140000 + 15000);
  assert.equal(o.surplus, 100000 - 155000);

  const grant = calculate({ purchase_price: 600000, lvr: 90, state: 'WA', legal_costs: 0, stamp_duty: 0, lmi: 0, other_costs: [{ label: 'Less: First Home Owner Grant', amount: -10000 }] });
  assert.equal(grant.total_contribution, 60000 - 10000, 'credits reduce the total');

  const high = calculate({ purchase_price: 500000, loan_amount: 490000 });
  assert.equal(high.lmi.auto_amount, null);
  assert.match(high.warnings[0], /over 95%/);
  assert.throws(() => calculate({ loan_amount: 1 }), /purchase price/);
  assert.throws(() => calculate({ purchase_price: 500000 }), /loan amount or the LVR/);
  assert.throws(() => calculate({ purchase_price: 500000, lvr: 80, other_costs: Array(13).fill({ amount: 1 }) }), /up to 12/);
});

test('starting figures from a deal', () => {
  const i = fromDeal({ property_value: 900000, loan_amount: 720000, loan_purpose: 'investment', property_address: '2 Bay St, Glenelg SA 5045' });
  assert.deepEqual([i.state, i.buyer, i.first_home, i.purchase_price], ['SA', 'investor', false, 900000]);
  assert.equal(fromDeal({ loan_purpose: 'first_home' }).first_home, true);
});

test('the calculators endpoint', async () => {
  const r = await api.post('/calculators/purchase', { purchase_price: 850000, lvr: 80, state: 'VIC' });
  assert.equal(r.status, 200);
  assert.equal(r.data.loan_amount, 680000);
  assert.equal(r.data.lmi.amount, 0);
  assert.equal((await api.post('/calculators/purchase', { purchase_price: -5 })).status, 400);
  assert.equal((await api.post('/calculators/lvr', { property_value: 800000, loan_amount: 720000 })).data.lmi_estimate, 11520, 'LVR calculator uses the same bands');
});

test('saved on a purchase deal, and applied to the deal', async () => {
  const c = (await api.post('/contacts', { first_name: 'Ella', last_name: 'Ng' })).data;
  const deal = (await api.post('/deals', { contact_id: c.id, loan_purpose: 'first_home', property_value: 650000, loan_amount: 585000, property_address: '4 Hill Rd, Hobart TAS 7000' })).data;
  let r = (await api.get(`/deals/${deal.id}/purchase-calc`)).data;
  assert.equal(r.saved, false);
  assert.equal(r.suggested, true);
  assert.equal(r.inputs.state, 'TAS');
  assert.equal(r.result.lvr, 90);

  const inputs = { ...r.inputs, lvr: 95, loan_basis: 'lvr', lmi_capitalised: true, other_costs: [{ label: 'Moving', amount: 1500 }] };
  r = (await api.put(`/deals/${deal.id}/purchase-calc`, { inputs, apply_to_deal: true })).data;
  assert.equal(r.saved, true);
  assert.equal(r.inputs.other_costs[0].label, 'Moving');
  const d = db.one('SELECT property_value, loan_amount, deposit FROM deals WHERE id = ?', deal.id);
  assert.deepEqual(d, Object.assign(Object.create(null), { property_value: 650000, loan_amount: r.result.total_loan, deposit: 32500 }));
  assert.ok(db.one("SELECT 1 FROM activities WHERE deal_id = ? AND body LIKE 'Purchase calculation applied:%'", deal.id));
  assert.equal((await api.put(`/deals/${deal.id}/purchase-calc`, { inputs: { purchase_price: 0 } })).status, 400);

  r = (await api.del(`/deals/${deal.id}/purchase-calc`)).data;
  assert.equal(r.saved, false);
  const refi = (await api.post('/deals', { contact_id: c.id, loan_purpose: 'refinance', loan_amount: 400000 })).data;
  assert.equal((await api.get(`/deals/${refi.id}/purchase-calc`)).data.suggested, false, 'not shown on a refinance unless saved');
  assert.equal((await api.get('/deals/99999/purchase-calc')).status, 404);
});
