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
let wbc;
let admin;
let broker;
let brokerApi;

test('setup', async () => {
  wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  admin = db.one("SELECT id FROM users WHERE email = 'admin@test.local'").id;
  broker = (await api.post('/users', { name: 'Jordan Lee', email: 'jordan@test.local', password: 'password123', role: 'broker' })).data.id;
  brokerApi = srv.client();
  await brokerApi.login('jordan@test.local', 'password123');
});

test('lender contacts: BDMs and others, with one main contact', async () => {
  const bad = await api.post(`/lenders/${wbc}/contacts`, { name: '', email: 'x@y.example' });
  assert.equal(bad.status, 400);
  assert.equal((await api.post(`/lenders/${wbc}/contacts`, { name: 'X', email: 'not-an-email' })).status, 400);
  assert.equal((await api.post(`/lenders/${wbc}/contacts`, { name: 'X', role: 'ceo' })).status, 400);
  assert.equal((await api.post('/lenders/99999/contacts', { name: 'X' })).status, 404);

  const hannah = (await api.post(`/lenders/${wbc}/contacts`, { name: 'Hannah Price', email: 'Hannah.Price@WBC.example', mobile: '0411 222 333', region: 'NSW' })).data;
  assert.equal(hannah.is_primary, true, 'first BDM becomes the main contact');
  assert.equal(hannah.email, 'hannah.price@wbc.example');
  assert.equal(hannah.role_label, 'BDM');
  const desk = (await api.post(`/lenders/${wbc}/contacts`, { name: 'Scenario desk', role: 'scenario_desk', email: 'scenarios@wbc.example' })).data;
  assert.equal(desk.is_primary, false);

  let list = (await api.get('/lenders')).data.rows.find((l) => l.id === wbc);
  assert.equal(list.bdm_name, 'Hannah Price');
  assert.equal(list.bdm_phone, '0411 222 333');
  assert.equal(list.contact_count, 2);

  const sam = (await api.post(`/lenders/${wbc}/contacts`, { name: 'Sam BDM', email: 'sam@wbc.example', is_primary: true })).data;
  assert.equal(sam.is_primary, true);
  const contacts = (await api.get(`/lenders/${wbc}`)).data.contacts;
  assert.deepEqual(contacts.filter((c) => c.is_primary).map((c) => c.name), ['Sam BDM'], 'only one main contact');
  list = (await api.get('/lenders')).data.rows.find((l) => l.id === wbc);
  assert.equal(list.bdm_name, 'Sam BDM');

  assert.equal((await api.patch(`/lenders/contacts/${sam.id}`, { mobile: '0400 000 001', name: '' })).status, 400);
  const patched = (await api.patch(`/lenders/contacts/${sam.id}`, { mobile: '0400 000 001' })).data;
  assert.equal(patched.mobile, '0400 000 001');
  assert.equal((await api.del(`/lenders/contacts/${sam.id}`)).status, 200);
  assert.equal((await api.del(`/lenders/contacts/${sam.id}`)).status, 404);
});

test('accreditation numbers: each broker has their own; only they or an admin can change them', async () => {
  const mine = await api.put(`/lenders/${wbc}/accreditations/${admin}`, { accreditation_number: 'WBC-448120', accredited_on: '2024-03-01', renewal_due: addDays(today(), 30) });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.status, 'active');
  assert.equal(mine.data.renewal_soon, true);
  assert.equal((await api.put(`/lenders/${wbc}/accreditations/${admin}`, { renewal_due: '01/02/2027' })).status, 400);
  assert.equal((await api.put(`/lenders/${wbc}/accreditations/${admin}`, { status: 'expired' })).status, 400);
  assert.equal((await api.put(`/lenders/${wbc}/accreditations/99999`, { accreditation_number: '1' })).status, 400);

  // Jordan records their own, but can't change the admin's.
  assert.equal((await brokerApi.put(`/lenders/${wbc}/accreditations/${broker}`, { accreditation_number: 'WBC-500001', status: 'pending' })).status, 200);
  assert.equal((await brokerApi.put(`/lenders/${wbc}/accreditations/${admin}`, { accreditation_number: 'hacked' })).status, 403);
  // An admin can set a team member's.
  assert.equal((await api.put(`/lenders/${wbc}/accreditations/${broker}`, { status: 'active' })).data.accreditation_number, 'WBC-500001', 'updates keep other fields');

  const page = (await api.get(`/lenders/${wbc}`)).data;
  assert.deepEqual(page.accreditations.map((a) => [a.user_name, a.accreditation_number, a.status]), [['Admin User', 'WBC-448120', 'active'], ['Jordan Lee', 'WBC-500001', 'active']]);
  // The Lenders list shows each broker their own number.
  assert.equal((await api.get('/lenders')).data.rows.find((l) => l.id === wbc).accreditation_number, 'WBC-448120');
  assert.equal((await brokerApi.get('/lenders')).data.rows.find((l) => l.id === wbc).accreditation_number, 'WBC-500001');

  const adminRecord = page.accreditations.find((a) => a.user_id === admin);
  assert.equal((await brokerApi.del(`/lenders/accreditations/${adminRecord.id}`)).status, 403);
  // Overdue renewals are flagged.
  await api.put(`/lenders/${wbc}/accreditations/${admin}`, { renewal_due: addDays(today(), -3) });
  assert.equal((await api.get(`/lenders/${wbc}`)).data.accreditations.find((a) => a.user_id === admin).renewal_overdue, true);
});

test('deals show the broker\'s accreditation number and the lender\'s BDM', async () => {
  const client = (await api.post('/contacts', { first_name: 'Dee', email: 'dee@example.com' })).data;
  const deal = (await api.post('/deals', { contact_id: client.id, lender_id: wbc, owner_id: broker, loan_amount: 400000 })).data;
  const d = (await api.get(`/deals/${deal.id}`)).data;
  assert.equal(d.accreditation.accreditation_number, 'WBC-500001');
  assert.equal(d.lender_contacts[0].name, 'Hannah Price');
  const page = (await api.get(`/lenders/${wbc}`)).data;
  assert.ok(page.deals.some((x) => x.id === deal.id), 'open deals listed on the lender');
});

test('emailing a BDM without Outlook: logged on the lender, and on the client when about one', async () => {
  const client = db.one("SELECT id FROM contacts WHERE first_name = 'Dee'");
  const deal = db.one('SELECT id FROM deals WHERE contact_id = ?', client.id);
  const r = await api.post('/outbox', {
    to_email: 'hannah.price@wbc.example', subject: 'Dee – valuation query', body: 'Hi Hannah', lender_id: wbc, contact_id: client.id, deal_id: deal.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'logged');
  assert.equal(r.data.lender_id, wbc);
  const act = db.one("SELECT * FROM activities WHERE contact_id = ? AND type = 'email' ORDER BY id DESC LIMIT 1", client.id);
  assert.equal(act.body, 'Email logged (no Outlook or SMTP connected) to Westpac (Hannah Price, BDM): Dee – valuation query');
  assert.equal(act.deal_id, deal.id);

  const general = await api.post('/outbox', { to_email: 'scenarios@wbc.example', subject: 'Policy question', body: 'Hi', lender_id: wbc });
  assert.equal(general.status, 201);
  const page = (await api.get(`/lenders/${wbc}`)).data;
  assert.deepEqual(page.outbox.map((e) => e.subject), ['Policy question', 'Dee – valuation query']);
  assert.equal(page.outbox[1].contact_name.trim(), 'Dee');
  assert.equal((await api.post('/outbox', { to_email: 'a@b.example', subject: 'x', body: 'x', lender_id: 99999 })).status, 404);
});

test('upgrading: each lender\'s old single BDM becomes its main BDM contact', () => {
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE lenders (id INTEGER PRIMARY KEY, name TEXT, bdm_name TEXT, bdm_email TEXT, bdm_phone TEXT);
    INSERT INTO lenders VALUES (1, 'A', 'Ann', 'ann@a.example', '02 1'), (2, 'B', NULL, 'bdm@b.example', NULL), (3, 'C', '  ', NULL, NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE emails (id INTEGER PRIMARY KEY, account_id INTEGER, conversation_id TEXT); CREATE TABLE outbox (id INTEGER PRIMARY KEY);`);
  const migrations = require('../src/db/migrations');
  old.exec(migrations[11]);
  assert.deepEqual(old.prepare('SELECT lender_id, name, role, email, phone, is_primary FROM lender_contacts ORDER BY lender_id').all().map((r) => ({ ...r })), [
    { lender_id: 1, name: 'Ann', role: 'bdm', email: 'ann@a.example', phone: '02 1', is_primary: 1 },
    { lender_id: 2, name: 'bdm@b.example', role: 'bdm', email: 'bdm@b.example', phone: null, is_primary: 1 },
  ]);
  old.close();
});
