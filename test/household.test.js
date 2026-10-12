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

let mia;
let tom;
let relId;

test('linking a partner creates them with the shared surname and address', async () => {
  mia = (await api.post('/contacts', {
    first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com', mobile: '0400 000 001', status: 'client',
    address: '1 Main St', suburb: 'Ryde', state: 'NSW', postcode: '2112',
  })).data;
  const r = await api.post(`/contacts/${mia.id}/relationships`, {
    new_contact: { first_name: 'Tom', email: 'tom@example.com' }, relationship: 'spouse', shared_finances: 1,
  });
  assert.equal(r.status, 201);
  relId = r.data.id;
  tom = (await api.get(`/contacts/${r.data.related_id}`)).data;
  assert.equal(tom.last_name, 'Jones');
  assert.equal(tom.status, 'client');
  assert.equal(tom.suburb, 'Ryde');
  assert.equal(tom.relationships[0].relationship, 'spouse');
  assert.equal(tom.relationships[0].contact.id, mia.id);
  assert.equal(tom.relationships[0].shared_finances, true);
  assert.deepEqual(tom.household.map((m) => m.first_name).sort(), ['Mia', 'Tom']);

  const hh = (await api.get(`/contacts/${mia.id}/household`)).data;
  assert.equal(hh.rows.length, 2);
  assert.equal(hh.related[0].contact.first_name, 'Tom');
});

test('duplicate links, self links and failed new contacts are refused', async () => {
  assert.equal((await api.post(`/contacts/${tom.id}/relationships`, { related_id: mia.id })).status, 409);
  assert.equal((await api.post(`/contacts/${mia.id}/relationships`, { related_id: mia.id })).status, 400);
  assert.equal((await api.post(`/contacts/${mia.id}/relationships`, {})).status, 400);
  const before = db.one('SELECT COUNT(*) AS n FROM contacts').n;
  const bad = await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Ava' }, relationship: 'cousin' });
  assert.equal(bad.status, 400);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM contacts').n, before, 'no stray contact left behind');
});

test('parent/child relationships read the right way round from each side', async () => {
  const kid = (await api.post('/contacts', { first_name: 'Ava', last_name: 'Jones' })).data;
  await api.post(`/contacts/${mia.id}/relationships`, { related_id: kid.id, relationship: 'child' });
  const fromKid = (await api.get(`/contacts/${kid.id}`)).data.relationships;
  assert.equal(fromKid[0].relationship, 'parent');
  assert.equal(fromKid[0].reversed, true);
  const fromMia = (await api.get(`/contacts/${mia.id}`)).data.relationships.find((r) => r.contact.id === kid.id);
  assert.equal(fromMia.relationship, 'child');
  // A child without shared finances isn't part of the household.
  assert.equal((await api.get(`/contacts/${mia.id}`)).data.household.length, 2);
});

test('moving house moves the partner too', async () => {
  await api.patch(`/contacts/${mia.id}`, { address: '9 New Rd', suburb: 'Epping' });
  const t = (await api.get(`/contacts/${tom.id}`)).data;
  assert.equal(t.address, '9 New Rd');
  assert.equal(t.suburb, 'Epping');
  assert.equal(t.postcode, '2112');
});

test('the mortgage tracker is combined on both profiles', async () => {
  const home = (await api.post('/tracker/properties', { contact_id: mia.id, co_owner_id: tom.id, address: '9 New Rd, Epping NSW', valuation: { amount: 1200000, method: 'full' } })).data;
  const cba = db.one("SELECT id FROM lenders WHERE name = 'Commonwealth Bank'").id;
  await api.post('/tracker/loans', { contact_id: tom.id, co_borrower_id: mia.id, lender_id: cba, loan_type: 'home_loan', balance: 600000, security_ids: [home.id] });
  await api.post('/tracker/assets', { contact_id: tom.id, asset_type: 'savings', value: 30000 });
  for (const [id, name] of [[mia.id, 'Mia & Tom Jones'], [tom.id, 'Tom & Mia Jones']]) {
    const s = (await api.get(`/tracker/contacts/${id}`)).data;
    assert.equal(s.household_name, name);
    assert.equal(s.properties.length, 1);
    assert.equal(s.loans.length, 1);
    assert.equal(s.totals.total_debt, 600000);
    assert.equal(s.totals.other_assets, 30000);
    assert.equal(s.structure.totals.lvr, 50);
  }
  // Tom can secure a loan on the home Mia owns.
  const loan = await api.post('/tracker/loans', { contact_id: tom.id, lender_name: 'ANZ', balance: 50000, security_ids: [home.id] });
  assert.equal(loan.status, 201);
  assert.deepEqual(db.all('SELECT property_id FROM loan_securities WHERE loan_id = ?', loan.data.id).map((r) => r.property_id), [home.id]);
  // An unrelated contact can't.
  const other = (await api.post('/contacts', { first_name: 'Zed' })).data;
  const bad = await api.post('/tracker/loans', { contact_id: other.id, lender_name: 'ANZ', balance: 1, security_ids: [home.id] });
  assert.equal(bad.status, 400);
});

test('new deals default to both partners as borrowers', async () => {
  const deal = (await api.post('/deals', { contact_id: mia.id, loan_purpose: 'refinance', loan_amount: 600000 })).data;
  assert.equal(deal.co_borrower_id, tom.id);
  const t = (await api.get(`/contacts/${tom.id}`)).data;
  assert.ok(t.deals.some((d) => d.id === deal.id), 'joint deal shows on the partner too');
  const solo = (await api.post('/deals', { contact_id: mia.id, co_borrower_id: null, loan_purpose: 'other' })).data;
  assert.equal(solo.co_borrower_id, null);
});

test('templates can be addressed to one or both partners', async () => {
  const tpl = db.one("SELECT id FROM email_templates WHERE name = 'Pre-approval obtained'").id;
  const one = (await api.post(`/templates/${tpl}/preview`, { contact_id: mia.id })).data;
  assert.match(one.body, /^Hi Mia,/);
  assert.equal(one.to, 'mia@example.com');

  const both = (await api.post(`/templates/${tpl}/preview`, { contact_id: mia.id, addressee_ids: [mia.id, tom.id] })).data;
  assert.match(both.body, /^Hi Mia and Tom,/);
  assert.equal(both.to, 'mia@example.com, tom@example.com');

  // Someone outside the household can't be slipped in.
  const zed = db.one("SELECT id FROM contacts WHERE first_name = 'Zed'").id;
  const sneaky = (await api.post(`/templates/${tpl}/preview`, { contact_id: mia.id, addressee_ids: [mia.id, zed] })).data;
  assert.match(sneaky.body, /^Hi Mia,/);
  assert.equal((await api.post(`/templates/${tpl}/preview`, { contact_id: mia.id, addressee_ids: 'nope' })).status, 200);

  const sent = await api.post(`/templates/${tpl}/send`, { contact_id: mia.id, addressee_ids: [mia.id, tom.id] });
  assert.equal(sent.status, 201);
  const row = db.one('SELECT to_email, body FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(row.to_email, 'mia@example.com, tom@example.com');
  assert.match(row.body, /^Hi Mia and Tom,/);
});

test('stage-change emails on a joint deal go to both borrowers', async () => {
  const deal = (await api.post('/deals', { contact_id: tom.id, loan_purpose: 'purchase', loan_amount: 500000 })).data;
  assert.equal(deal.co_borrower_id, mia.id);
  await api.post(`/deals/${deal.id}/stage`, { stage: 'pre_approval' });
  const row = db.one("SELECT to_email, body FROM outbox WHERE deal_id = ? AND subject LIKE '%re-approv%' ORDER BY id DESC LIMIT 1", deal.id);
  assert.ok(row, 'pre-approval email queued');
  assert.equal(row.to_email, 'tom@example.com, mia@example.com');
  assert.match(row.body, /^Hi Tom and Mia,/);
});

test('lending reviews are addressed to the household and can be narrowed', async () => {
  const r = (await api.post('/reviews', { contact_id: mia.id })).data;
  const full = (await api.get(`/reviews/${r.id}`)).data;
  assert.deepEqual(full.addressees.map((a) => a.first_name), ['Mia', 'Tom']);
  assert.equal(full.prepared_for, 'Mia & Tom Jones');
  assert.match(full.loan_review, /Commonwealth Bank/);

  const head = await fetch(`${srv.base}/reviews/${r.id}/docx`, { headers: { Cookie: await cookie() } });
  assert.match(head.headers.get('content-disposition'), /Mia & Tom Jones/);

  assert.equal((await api.patch(`/reviews/${r.id}`, { addressee_ids: [] })).status, 400);
  assert.equal((await api.patch(`/reviews/${r.id}`, { addressee_ids: 'x' })).status, 400);
  const zed = db.one("SELECT id FROM contacts WHERE first_name = 'Zed'").id;
  assert.equal((await api.patch(`/reviews/${r.id}`, { addressee_ids: [zed] })).status, 400);
  assert.equal((await api.patch(`/reviews/${r.id}`, { addressee_ids: [tom.id] })).status, 200);
  const narrowed = (await api.get(`/reviews/${r.id}`)).data;
  assert.equal(narrowed.prepared_for, 'Tom Jones');
  const html = await (await fetch(`${srv.base}/reviews/${r.id}/preview`, { headers: { Cookie: await cookie() } })).text();
  assert.match(html, /Tom Jones/);
  assert.doesNotMatch(html, /Mia &amp; Tom Jones|Mia & Tom Jones/);

  await api.patch(`/reviews/${r.id}`, { addressee_ids: [mia.id, tom.id] });
  const sent = await api.post(`/reviews/${r.id}/email`, { to: 'mia@example.com, tom@example.com', subject: 'Your review', body: 'Hi Mia and Tom' });
  assert.equal(sent.status, 200);
  for (const id of [mia.id, tom.id]) {
    assert.ok((await api.get(`/contacts/${id}`)).data.activities.some((a) => /Lending review emailed/.test(a.body)), 'logged on both');
  }
});

test('unlinking separates the finances again', async () => {
  const patched = await api.patch(`/contacts/relationships/${relId}`, { shared_finances: 0 });
  assert.equal(patched.data.shared_finances, 0);
  assert.equal((await api.get(`/tracker/contacts/${tom.id}`)).data.household_name, 'Tom Jones');
  await api.patch(`/contacts/relationships/${relId}`, { shared_finances: 1 });
  assert.equal((await api.del(`/contacts/relationships/${relId}`)).status, 200);
  const t = (await api.get(`/contacts/${tom.id}`)).data;
  assert.equal(t.relationships.length, 0);
  assert.equal(t.household.length, 1);
  assert.equal((await api.del(`/contacts/relationships/${relId}`)).status, 404);
});

async function cookie() {
  const res = await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
