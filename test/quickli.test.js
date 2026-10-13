'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

// A stand-in Quickli that checks every request's signature with the public key.
let publicKey = null;
const seen = [];
const scenarios = new Map();
const quickli = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const path = req.url.split('?')[0];
  const h = req.headers;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const canonical = [req.method, path, h['x-auth-timestamp'], crypto.createHash('sha256').update(raw).digest('hex')].join('\n');
  const valid = publicKey && h['x-auth-signature'] && crypto.createVerify('RSA-SHA256').update(canonical).verify(publicKey, h['x-auth-signature'], 'base64');
  seen.push({ method: req.method, path, headers: h, body: raw ? JSON.parse(raw) : null, valid });
  if (!valid || h['x-auth-integration-partner-id'] !== 'partner-efh' || h['x-auth-key-id'] !== 'key-1') return json(401, { message: 'Invalid signature' });
  if (h['x-auth-broker-access-token'] !== 'qk_broker_token_123') return json(401, { message: 'Invalid broker access token' });
  if (path === '/api/v3/whoami') return json(200, { broker: { email: 'admin@test.local', name: 'Admin' }, partner: 'EFH CRM' });
  const ready = (s) => ({ ready: s.living_expenses?.[0]?.simple_basic_expense > 0, issues: s.living_expenses?.[0]?.simple_basic_expense > 0 ? [] : ['Living expenses are missing for household 1'] });
  if (path === '/api/v3/scenarios' && req.method === 'POST') {
    const id = `sc_${scenarios.size + 101}`;
    const body = JSON.parse(raw);
    scenarios.set(id, body);
    return json(201, { id, description: body.description, calcReadinessCheck: ready(body.scenario) });
  }
  const m = /^\/api\/v3\/scenarios\/([\w-]+)$/.exec(path);
  if (m) {
    if (!scenarios.has(m[1]) && m[1] !== 'sc_external') return json(404, { message: 'Scenario not found' });
    if (req.method === 'PUT') scenarios.set(m[1], JSON.parse(raw));
    const body = scenarios.get(m[1]) || { scenario: { living_expenses: [{ simple_basic_expense: 3500 }] } };
    return json(200, { id: m[1], ...body, calcReadinessCheck: ready(body.scenario) });
  }
  return json(404, { message: 'no route' });
});

let srv;
let api;
let db;
let deal;
let mia;
before(async () => {
  await new Promise((r) => { quickli.listen(0, '127.0.0.1', r); });
  process.env.QUICKLI_API_URL = `http://127.0.0.1:${quickli.address().port}`;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => { srv.close(); quickli.close(); });

test('setup: a couple with income, a home, a car loan and an investment purchase', async () => {
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones', employment_type: 'payg', annual_income: 120000, postcode: '2042', dependants: 1 })).data;
  const tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom', employment_type: 'self_employed', annual_income: 90000 }, relationship: 'spouse', shared_finances: 1 })).data;
  const home = (await api.post('/tracker/properties', { contact_id: mia.id, co_owner_id: tom.related_id, address: '8 King St, Newtown NSW 2042', postcode: '2042', property_type: 'house', usage: 'owner_occupied', valuation: { amount: 1200000, method: 'avm' } })).data;
  await api.post('/tracker/loans', { contact_id: mia.id, co_borrower_id: tom.related_id, lender_name: 'Westpac', loan_type: 'home_loan', limit_amount: 700000, balance: 650000, interest_rate: 5.89, rate_type: 'variable', repayment_amount: 4200, repayment_frequency: 'monthly', security_ids: [home.id] });
  await api.post('/tracker/loans', { contact_id: mia.id, lender_name: 'Toyota Finance', loan_type: 'car', limit_amount: 30000, balance: 22000, interest_rate: 7.5, repayment_amount: 300, repayment_frequency: 'fortnightly' });
  await api.post('/tracker/loans', { contact_id: tom.related_id, lender_name: 'ATO', loan_type: 'hecs', balance: 18000 });
  deal = (await api.post('/deals', { contact_id: mia.id, co_borrower_id: tom.related_id, loan_purpose: 'investment', property_value: 750000, loan_amount: 600000, loan_term_years: 30, property_address: '3/14 Smith St, Marrickville NSW 2204' })).data;
});

test('the scenario is built from the deal and the mortgage tracker', async () => {
  const r = (await api.get(`/deals/${deal.id}/quickli`)).data;
  assert.equal(r.configured, false);
  const s = r.scenario;
  assert.deepEqual(s.households[0], { id: 'crm-household-1', status: 'married', num_adults: 2, num_dependants: 1, shared_with_households: [], postcode: 2042 });
  assert.equal(s.income[0].payg, 120000);
  assert.equal(s.income[1].payg, undefined, 'self-employed income goes in Quickli');
  assert.equal(s.income[1].HECS, true);
  assert.equal(s.income[1].HECS_balance, 18000);
  const home = s.securities.find((x) => x.address?.startsWith('8 King'));
  assert.deepEqual([home.transaction_type, home.property_purpose, home.value, home.postcode, home.applicant_ownership], ['owns_with_mortgage', 'owner_occupied', 1200000, 2042, [50, 50]]);
  const purchase = s.securities.find((x) => x.transaction_type === 'purchasing');
  assert.deepEqual([purchase.property_purpose, purchase.value], ['investment', 750000]);
  assert.deepEqual(s.existing_home_loans.map((l) => [l.lender, l.loan_balance, l.actual_rate, l.monthly_repayment, l.loan_type, l.ignore]), [['Westpac', 650000, 5.89, 4200, 'owner_occupied', false]]);
  assert.deepEqual(s.liabilities.map((l) => [l.loan_type, l.lender, l.limit, l.monthly_repayment]), [['car', 'Toyota Finance', 30000, 650]]);
  assert.deepEqual(s.proposed_home_loans[0], {
    id: `crm-proposed-${deal.id}`, product_type: 'variable_package', loan_type: 'investment', loan_amount: 600000, term: 30, interest_only_period: 0, use_generic_rate: false, is_tax_deductible: true, lvr: 80,
  });
  assert.ok(s.home_loan_security_links.some((l) => l.which_proposed_home_loan_ids?.[0] === `crm-proposed-${deal.id}` && l.which_security_ids[0] === 'crm-security-purchase'));
  assert.ok(r.warnings.some((w) => /Tom is self-employed/.test(w)));
  assert.ok(r.warnings.some((w) => /Living expenses/.test(w)));
  assert.match(r.summary.new_loan, /\$600,000 investment, 30 years, variable package, LVR 80%/);
});

test('setup: the admin makes a key, enters the partner details; each broker adds a token', async () => {
  assert.equal((await api.post(`/deals/${deal.id}/quickli/push`)).status, 400, 'not set up');
  const k = (await api.post('/quickli/key')).data;
  assert.match(k.public_key, /^-----BEGIN PUBLIC KEY-----/);
  assert.equal(k.configured, false, 'still needs the partner and key IDs');
  publicKey = k.public_key;
  assert.equal((await api.put('/quickli/config', { partner_id: 'bad id with spaces' })).status, 400);
  const c = (await api.put('/quickli/config', { partner_id: 'partner-efh', key_id: 'key-1', scenario_url: 'https://app.quickli.com.au/scenarios/{id}' })).data;
  assert.equal(c.configured, true);
  assert.notEqual(db.getSetting('quickli_private_key'), '', 'stored');
  assert.doesNotMatch(db.getSetting('quickli_private_key'), /BEGIN PRIVATE KEY/, 'encrypted');

  const wrong = (await api.put('/quickli/token', { token: 'qk_wrong_token_999' })).data;
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /didn't accept the connection.*Invalid broker access token/);
  const ok = (await api.put('/quickli/token', { token: 'qk_broker_token_123' })).data;
  assert.equal(ok.ok, true);
  assert.equal(ok.token.whoami.partner, 'EFH CRM');
  assert.ok(seen.every((r) => r.valid), 'every request correctly signed');
  const h = seen.at(-1).headers;
  assert.deepEqual(Object.keys(h).filter((k) => k.startsWith('x-auth-')).sort(), ['x-auth-broker-access-token', 'x-auth-integration-partner-id', 'x-auth-key-id', 'x-auth-signature', 'x-auth-timestamp']);
});

test('sending the deal creates a scenario, then updates it', async () => {
  let r = await api.post(`/deals/${deal.id}/quickli/push`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.link.scenario_id, 'sc_101');
  assert.equal(r.data.link.url, 'https://app.quickli.com.au/scenarios/sc_101');
  assert.equal(r.data.link.calc_ready, false);
  assert.deepEqual(r.data.link.issues, ['Living expenses are missing for household 1']);
  const sent = seen.at(-1);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.valid, true, 'body hash matches what was sent');
  assert.match(sent.body.description, /Mia Jones & Tom Jones/);
  assert.equal(sent.body.scenario.proposed_home_loans[0].loan_amount, 600000);
  assert.ok(db.one("SELECT 1 FROM activities WHERE deal_id = ? AND body = 'Created Quickli scenario sc_101'", deal.id));

  await api.patch(`/deals/${deal.id}`, { loan_amount: 620000 });
  r = (await api.post(`/deals/${deal.id}/quickli/push`)).data;
  assert.equal(seen.at(-1).method, 'PUT');
  assert.equal(seen.at(-1).path, '/api/v3/scenarios/sc_101');
  assert.equal(seen.at(-1).body.scenario.proposed_home_loans[0].loan_amount, 620000);
  assert.equal(r.link.scenario_id, 'sc_101');
  assert.equal(scenarios.size, 1, 'updated, not duplicated');
});

test('linking an existing scenario, refreshing, recording results, unlinking', async () => {
  const other = (await api.post('/deals', { contact_id: mia.id, loan_purpose: 'refinance', loan_amount: 650000, property_address: '8 King St, Newtown NSW 2042' })).data;
  const sc = (await api.get(`/deals/${other.id}/quickli`)).data.scenario;
  assert.equal(sc.existing_home_loans[0].ignore, true, 'the loan being refinanced is paid out');
  assert.ok(sc.home_loan_security_links.some((l) => l.which_proposed_home_loan_ids && l.which_security_ids[0].startsWith('crm-security-')), 'new loan linked to the home');

  assert.equal((await api.post(`/deals/${other.id}/quickli/link`, { scenario_id: 'sc_missing' })).status, 404);
  const linked = (await api.post(`/deals/${other.id}/quickli/link`, { scenario_id: 'https://app.quickli.com.au/scenarios/sc_external' })).data;
  assert.equal(linked.link.scenario_id, 'sc_external');
  assert.equal(linked.link.calc_ready, true);
  const refreshed = (await api.post(`/deals/${other.id}/quickli/refresh`)).data;
  assert.equal(refreshed.link.calc_ready, true);

  assert.equal((await api.put(`/deals/${other.id}/quickli/results`, { max_borrowing: 'lots' })).status, 400);
  const res = (await api.put(`/deals/${other.id}/quickli/results`, { max_borrowing: '$1,150,000', lenders_passing: 18, best_lender: 'ING', surplus: 1250, notes: 'Strong servicing' })).data;
  assert.deepEqual([res.link.results.max_borrowing, res.link.results.lenders_passing, res.link.results.best_lender], [1150000, 18, 'ING']);
  const unl = (await api.del(`/deals/${other.id}/quickli`)).data;
  assert.equal(unl.link, null);
});

test('Quickli rejecting the connection never signs the broker out', async () => {
  await api.put('/quickli/config', { key_id: 'key-unknown' });
  const r = await api.post(`/deals/${deal.id}/quickli/push`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /didn't accept the connection/);
  await api.put('/quickli/config', { key_id: 'key-1' });
  assert.equal((await api.post('/quickli/key', { private_key: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----' })).status, 400, 'PKCS#1 refused');
  assert.equal((await api.del('/quickli/token')).data.token, null);
});
