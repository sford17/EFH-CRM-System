'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
let db;
let sms;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  sms = require('../src/services/sms');
});
after(() => srv.close());

let alex;
const settle = async (contactId) => {
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  const deal = (await api.post('/deals', { contact_id: contactId, loan_amount: 600000, lender_id: wbc, settlement_date: '2026-10-01' })).data;
  assert.equal((await api.post(`/deals/${deal.id}/stage`, { stage: 'settled' })).status, 200);
  await sms.processSms();
  return deal;
};
const lastRun = () => db.one(
  "SELECT r.detail FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.name = 'Settled: thank the referral partner' ORDER BY r.id DESC LIMIT 1",
).detail;

test('the thank-you automation is installed and switched on', () => {
  const a = db.one("SELECT * FROM automations WHERE name = 'Settled: thank the referral partner'");
  assert.equal(a.enabled, 1);
  assert.deepEqual(JSON.parse(a.actions)[0].to, 'referral_partner');
});

test('when a referred client settles, the referral partner gets a text', async () => {
  alex = (await api.post('/partners', { name: 'Alex Morgan', company: 'Harbourside Realty', type: 'real_estate', mobile: '0412 345 678' })).data;
  assert.equal(alex.sms_updates, 1, 'on by default');
  const client = (await api.post('/contacts', { first_name: 'Rich', last_name: 'Client', mobile: '0400 000 111', referral_partner_id: alex.id })).data;
  const deal = await settle(client.id);

  const text = db.one('SELECT * FROM sms_messages WHERE partner_id = ?', alex.id);
  assert.equal(text.to_number, '+61412345678');
  assert.equal(text.deal_id, deal.id);
  assert.equal(text.contact_id, null, 'not one of the client\'s own texts');
  assert.match(text.body, /^Hi Alex, great news - Rich Client's loan has settled\. Thanks so much for the referral!/);
  assert.ok(text.body.length <= 160 && /^[\x20-\x7E]*$/.test(text.body), 'one standard SMS');
  assert.match(text.body, /Admin, EFH Mortgage Broking$/);
  assert.equal(text.status, 'logged', 'ClickSend not connected in tests');

  const c = (await api.get(`/contacts/${client.id}`)).data;
  assert.ok(c.activities.some((x) => x.body.startsWith('SMS to referral partner Alex Morgan (Harbourside Realty) logged (ClickSend not connected): Hi Alex')), 'noted on the client');
  assert.equal(c.sms.some((x) => x.body.startsWith('Hi Alex')), false);
  const d = (await api.get(`/deals/${deal.id}`)).data;
  assert.equal(d.sms.find((x) => x.body.startsWith('Hi Alex')).partner_name, 'Alex Morgan');
  const log = (await api.get('/sms')).data.rows.find((x) => x.partner_id === alex.id);
  assert.equal(log.partner_name, 'Alex Morgan');
  const partners = (await api.get('/partners')).data.rows;
  assert.equal(partners.find((p) => p.id === alex.id).texts_sent, 1);
});

test('no text when the partner is switched off, has no mobile, or there is no partner', async () => {
  await api.patch(`/partners/${alex.id}`, { sms_updates: 0 });
  const a = (await api.post('/contacts', { first_name: 'Off', referral_partner_id: alex.id })).data;
  await settle(a.id);
  assert.match(lastRun(), /SMS to referral partner skipped: Alex Morgan has text updates switched off/);

  const landline = (await api.post('/partners', { name: 'Priya Shah', type: 'accountant', phone: '02 9000 0000' })).data;
  const b = (await api.post('/contacts', { first_name: 'Landline', referral_partner_id: landline.id })).data;
  await settle(b.id);
  assert.match(lastRun(), /Priya Shah's number "02 9000 0000" is not a mobile/);

  const c = (await api.post('/contacts', { first_name: 'Walk-in' })).data;
  await settle(c.id);
  assert.match(lastRun(), /skipped: No referral partner/);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM sms_messages WHERE partner_id IS NOT NULL').n, 1, 'only the first one was texted');
});

test('the deal\'s referral partner wins over the contact\'s, and {{referrer.*}} works in any message', async () => {
  const other = (await api.post('/partners', { name: 'Ben Carter', type: 'buyers_agent', mobile: '0434 567 890' })).data;
  await api.patch(`/partners/${alex.id}`, { sms_updates: 1 });
  const client = (await api.post('/contacts', { first_name: 'Sue', last_name: 'Swap', referral_partner_id: alex.id })).data;
  const deal = (await api.post('/deals', { contact_id: client.id, referral_partner_id: other.id })).data;
  const { buildContext, render } = require('../src/services/templating');
  const ctx = buildContext({ dealId: deal.id });
  assert.equal(render('{{referrer.first_name}} at {{referrer.name}}', ctx), 'Ben at Ben Carter');
  assert.equal(render('[{{referrer.first_name}}]', buildContext({ contactId: (await api.post('/contacts', { first_name: 'Nobody' })).data.id })), '[]');
});

test('upgrading adds the automation once', () => {
  const { addReferralDefaults } = require('../src/db/migrations');
  db.run("DELETE FROM automations WHERE name = 'Settled: thank the referral partner'");
  addReferralDefaults(db);
  addReferralDefaults(db);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM automations WHERE name = 'Settled: thank the referral partner'").n, 1);
});
