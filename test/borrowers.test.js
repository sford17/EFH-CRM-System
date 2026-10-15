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
test('companies and trusts are contacts, linked to their people', async () => {
  for (const [k, first, last, email] of [['mia', 'Mia', 'Jones', 'mia@x.test'], ['tom', 'Tom', 'Jones', 'tom@x.test'], ['ava', 'Ava', 'Lee', 'ava@x.test']]) {
    ids[k] = (await api.post('/contacts', { first_name: first, last_name: last, email })).data.id;
  }
  const co = await api.post('/contacts', { entity_type: 'company', first_name: 'Jones Holdings Pty Ltd', last_name: 'ignored', abn: '51824753556', acn: '824753556', dob: '1990-01-01' });
  assert.equal(co.status, 201, JSON.stringify(co.data));
  assert.deepEqual([co.data.entity_type, co.data.last_name, co.data.abn, co.data.acn, co.data.dob, co.data.marketing_opt_in], ['company', null, '51 824 753 556', '824 753 556', null, 0]);
  ids.co = co.data.id;
  assert.equal((await api.post('/contacts', { entity_type: 'club', first_name: 'X' })).status, 400);

  // Linked from the company's page: stored as Mia → company.
  const link = await api.post(`/contacts/${ids.co}/relationships`, { related_id: ids.mia, relationship: 'director', shared_finances: true });
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const rel = db.one('SELECT * FROM contact_relationships WHERE id = ?', link.data.id);
  assert.deepEqual([rel.contact_id, rel.related_id, rel.shared_finances], [ids.mia, ids.co, 0], 'person → entity, never shared finances');
  assert.equal((await api.post(`/contacts/${ids.mia}/relationships`, { related_id: ids.ava, relationship: 'director' })).status, 400, 'director needs a company or trust');
  // A trust created on the spot from Tom's page.
  const trust = await api.post(`/contacts/${ids.tom}/relationships`, { relationship: 'trustee', new_contact: { entity_type: 'trust', first_name: 'Jones Family Trust', trust_type: 'discretionary' } });
  assert.equal(trust.status, 201, JSON.stringify(trust.data));
  ids.trust = trust.data.related_id;
  assert.equal(db.one('SELECT last_name FROM contacts WHERE id = ?', ids.trust).last_name, null);

  const mia = (await api.get(`/contacts/${ids.mia}`)).data;
  assert.deepEqual(mia.entities.map((e) => [e.first_name, e.relationship]), [['Jones Holdings Pty Ltd', 'director']]);
  const company = (await api.get(`/contacts/${ids.co}`)).data;
  assert.deepEqual(company.people.map((p) => [p.first_name, p.relationship]), [['Mia', 'director']]);
  assert.equal((await api.get('/contacts?entity_type=trust')).data.rows.length, 1);
});

let dealId;
test('a deal can have several co-borrowers, in order, including a company', async () => {
  const r = await api.post('/deals', { contact_id: ids.tom, co_borrower_ids: [ids.ava, ids.co, ids.ava, ids.tom], loan_amount: 900000 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  dealId = r.data.id;
  assert.equal(r.data.co_borrower_name, 'Ava Lee & Jones Holdings Pty Ltd');
  let d = (await api.get(`/deals/${dealId}`)).data;
  assert.deepEqual(d.borrowers.map((b) => [b.full_name, b.role, b.entity_type]), [['Tom Jones', 'main', 'person'], ['Ava Lee', 'co', 'person'], ['Jones Holdings Pty Ltd', 'co', 'company']]);
  assert.equal(d.co_borrower_id, ids.ava, 'first co-borrower kept for older code');

  await api.patch(`/deals/${dealId}`, { co_borrower_ids: [ids.co, ids.mia, ids.ava] });
  d = (await api.get(`/deals/${dealId}`)).data;
  assert.deepEqual(d.co_borrower_ids, [ids.co, ids.mia, ids.ava]);
  assert.equal(d.co_borrower_id, ids.co);
  // Making a co-borrower the main borrower takes them off the co-borrower list.
  await api.patch(`/deals/${dealId}`, { contact_id: ids.mia });
  d = (await api.get(`/deals/${dealId}`)).data;
  assert.deepEqual([d.contact_id, d.co_borrower_ids], [ids.mia, [ids.co, ids.ava]]);
  // Older single co-borrower field still works.
  const old = (await api.post('/deals', { contact_id: ids.ava, co_borrower_id: ids.tom })).data;
  assert.deepEqual((await api.get(`/deals/${old.id}`)).data.co_borrower_ids, [ids.tom]);
});

test('every borrower sees the deal; the company\'s directors do too', async () => {
  for (const who of ['mia', 'ava', 'co']) {
    assert.ok((await api.get(`/contacts/${ids[who]}`)).data.deals.some((x) => x.id === dealId), who);
  }
  assert.ok((await api.get('/deals?q=Holdings')).data.rows.some((x) => x.id === dealId), 'search by co-borrower');
  const contacts = (await api.get('/contacts?limit=50')).data.rows;
  assert.equal(contacts.find((c) => c.id === ids.ava).open_deals, 2);
});

test('emails go to every borrower; a company is reached through its directors', async () => {
  const { buildContext, borrowersOn } = require('../src/services/templating');
  db.run('DELETE FROM contact_relationships WHERE contact_id = ? AND related_id = ?', ids.mia, ids.co);
  await api.post(`/contacts/${ids.co}/relationships`, { related_id: ids.tom, relationship: 'director' });
  const all = borrowersOn({ id: dealId }, null);
  assert.ok(all.includes(ids.tom), 'the company\'s director');
  const ctx = buildContext({ contactId: ids.mia, dealId, addresseeIds: [ids.mia, ...all] });
  assert.deepEqual(ctx.addressees.map((c) => c.first_name ? c.id : null).sort(), [ids.mia, ids.co, ids.ava, ids.tom].sort());
  assert.equal(ctx.contact.first_name, 'Mia, Ava and Tom', 'the company isn\'t greeted');
});

test('the loan made at settlement has every borrower', async () => {
  const loanId = require('../src/services/tracker').createFromDeal(dealId);
  assert.deepEqual(require('../src/services/borrowers').coIds('loan', loanId), [ids.co, ids.ava]);
  const t = (await api.get(`/tracker/contacts/${ids.ava}`)).data;
  const loan = t.loans.find((n) => n.id === loanId);
  assert.ok(loan, 'on Ava\'s tracker');
  assert.equal(loan.co_borrower_name, 'Jones Holdings Pty Ltd & Ava Lee');
  // Deleting a co-borrower's contact keeps the list tidy.
  db.run('DELETE FROM contacts WHERE id = ?', ids.co);
  assert.equal(db.one('SELECT co_borrower_id FROM deals WHERE id = ?', dealId).co_borrower_id, ids.ava);
});
