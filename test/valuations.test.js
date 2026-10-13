'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
before(async () => {
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => srv.close());

const { today, addMonths } = require('../src/util');
const T = today();
let client;
let prop;
const value = async () => {
  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  const p = s.properties.find((x) => x.id === prop.id);
  return { p, sp: s.structure.properties.find((x) => x.id === prop.id), s };
};
const addVal = (method, amount, date) => api.post(`/tracker/properties/${prop.id}/valuations`, { method, amount, valuation_date: date });

test('setup: a property with a loan', async () => {
  client = (await api.post('/contacts', { first_name: 'Ava', last_name: 'Taylor' })).data;
  prop = (await api.post('/tracker/properties', { contact_id: client.id, address: '3 Oak St, Perth WA 6000', purchase_price: 600000 })).data;
  await api.post('/tracker/loans', { contact_id: client.id, lender_name: 'NAB', loan_type: 'home_loan', limit_amount: 500000, balance: 500000, security_ids: [prop.id] });
  const { p } = await value();
  assert.equal(p.current_value, 600000, 'purchase price until valued');
  assert.equal(p.valuation_basis.type, 'purchase_price');
});

test('the highest of the latest valuation of each method is used', async () => {
  await addVal('full', 820000, addMonths(T, -5)); // older full valuation, superseded below
  await addVal('full', 800000, addMonths(T, -3));
  await addVal('desktop', 845000, addMonths(T, -2));
  await addVal('avm', 790000, addMonths(T, -1)); // most recent, but lower
  await addVal('kerbside', 900000, addMonths(T, -30)); // highest, but too old
  await addVal('client_estimate', 1000000, T); // ignored while there are real valuations
  const { p, sp, s } = await value();
  assert.equal(p.current_value, 845000);
  assert.equal(p.current_valuation.method, 'desktop');
  assert.equal(p.valuation_basis.type, 'highest_recent');
  assert.equal(p.valuation_basis.compared_ids.length, 3, 'latest full, desktop and AVM');
  assert.match(p.valuation_basis.note, /^Highest of 3 recent valuations: .*Desktop valuation.* \(within 12 months of the newest\)$/);
  assert.equal(sp.lvr, Math.round((500000 / 845000) * 1000) / 10, 'LVR uses the chosen value');
  assert.equal(s.totals.property_value, 845000);
});

test('settings: most recent only, a longer window, and counting client estimates', async () => {
  assert.equal((await api.get('/settings')).data.valuation_rule, 'highest_recent', 'default');
  await api.put('/settings', { valuation_rule: 'latest' });
  assert.equal((await value()).p.current_value, 1000000, 'the client estimate is the newest');
  await api.put('/settings', { valuation_rule: 'highest_recent', valuation_recent_months: 36 });
  assert.equal((await value()).p.current_value, 900000, 'old kerbside now counts');
  await api.put('/settings', { valuation_recent_months: 12, valuation_ignore_estimates: 0 });
  assert.equal((await value()).p.current_value, 1000000);
  await api.put('/settings', { valuation_ignore_estimates: 1 });
  for (const bad of [{ valuation_rule: 'lowest' }, { valuation_recent_months: -1 }, { valuation_recent_months: 2.5 }]) {
    assert.equal((await api.put('/settings', bad)).status, 400, JSON.stringify(bad));
  }
});

test('the broker can choose the valuation for a property, and go back to automatic', async () => {
  const { p } = await value();
  const full = p.valuations.find((v) => v.method === 'full' && v.amount === 800000);
  assert.equal((await api.patch(`/tracker/properties/${prop.id}`, { valuation_id: full.id })).status, 200);
  let r = await value();
  assert.equal(r.p.current_value, 800000);
  assert.equal(r.p.valuation_basis.type, 'chosen');
  const other = (await api.post('/tracker/properties', { contact_id: client.id, address: '9 Elm St' })).data;
  assert.equal((await api.patch(`/tracker/properties/${other.id}`, { valuation_id: full.id })).status, 400, 'must be this property\'s');
  await api.patch(`/tracker/properties/${prop.id}`, { valuation_id: null });
  r = await value();
  assert.equal(r.p.current_value, 845000);
  // Deleting a chosen valuation falls back to the automatic choice.
  await api.patch(`/tracker/properties/${prop.id}`, { valuation_id: full.id });
  await api.del(`/tracker/valuations/${full.id}`);
  r = await value();
  assert.equal(r.p.valuation_basis.type, 'highest_recent');
  assert.equal(r.p.current_value, 845000);
});

test('client estimate alone is still used', async () => {
  const p2 = (await api.post('/tracker/properties', { contact_id: client.id, address: '1 Pine Rd', valuation: { amount: 700000 } })).data;
  const s = (await api.get(`/tracker/contacts/${client.id}`)).data;
  assert.equal(s.properties.find((x) => x.id === p2.id).current_value, 700000);
});
