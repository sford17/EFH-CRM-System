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

const LINK = 'https://g.page/r/CabcEFH123/review';
const AUTO = 'Settled: ask for a Google review';
const runDetail = () => db.one(
  'SELECT r.detail FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.name = ? ORDER BY r.id DESC LIMIT 1', AUTO,
)?.detail;
let wbc;
const settleFor = async (contact) => {
  const deal = (await api.post('/deals', { contact_id: contact.id, lender_id: wbc, loan_amount: 500000, settlement_date: '2026-10-01' })).data;
  assert.equal((await api.post(`/deals/${deal.id}/stage`, { stage: 'settled' })).status, 200);
  return deal;
};

test('the review request comes with a Google review button, an SMS and its own automation', () => {
  wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  const t = db.one("SELECT * FROM email_templates WHERE name = 'Review request'");
  assert.match(t.body, /\[\[button: Leave a Google review \| \{\{business.google_review_link\}\}\]\]/);
  assert.match(t.sms_body, /\{\{business.google_review_link\}\}/);
  const a = db.one('SELECT * FROM automations WHERE name = ?', AUTO);
  assert.equal(a.enabled, 1);
  assert.deepEqual(JSON.parse(a.conditions)[1], { field: 'contact.google_reviewed_at', op: 'empty' });
  assert.equal(JSON.parse(a.actions)[0].delay_days, 2);
  const settled = db.one("SELECT actions FROM automations WHERE name = 'Settled: congratulate, convert to client & book commissions'");
  assert.equal(JSON.parse(settled.actions).some((x) => x.template_id === t.id), false, 'not asked twice');
});

test('nothing is sent until the Google review link is set', async () => {
  const c = (await api.post('/contacts', { first_name: 'Early', email: 'early@example.com', mobile: '0400 000 001' })).data;
  await settleFor(c);
  assert.match(runDetail(), /email skipped: Add your Google review link in Settings/);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE 'How did we do%'").n, 0);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM sms_messages WHERE body LIKE '%Google review%'").n, 0);
  const draft = (await api.get(`/contacts/${c.id}/review-request`)).data;
  assert.equal(draft.link, '');
  assert.equal((await api.post(`/contacts/${c.id}/review-request`, { email: { subject: 'x', body: 'y' } })).status, 400);
});

test('the link is checked when saved', async () => {
  assert.equal((await api.put('/settings', { google_review_link: 'g.page/r/abc' })).status, 400);
  assert.equal((await api.put('/settings', { google_review_link: LINK })).status, 200);
});

test('after settlement the client gets the email and SMS, two days later', async () => {
  const c = (await api.post('/contacts', { first_name: 'Sam', last_name: 'Settled', email: 'sam@example.com', mobile: '0400 000 002' })).data;
  await settleFor(c);
  const email = db.one("SELECT * FROM outbox WHERE contact_id = ? AND subject = 'How did we do, Sam?'", c.id);
  assert.ok(email.send_after > new Date(Date.now() + 47 * 3600000).toISOString(), 'sent after 2 days');
  const { buildEmail } = require('../src/services/emailHtml');
  const built = buildEmail({ body: email.body, context: { contactId: c.id } });
  assert.match(built.html, new RegExp(`<a href="${LINK}"[^>]*>Leave a Google review</a>`));
  const sms = db.one('SELECT * FROM sms_messages WHERE contact_id = ? AND body LIKE ?', c.id, '%g.page%');
  assert.ok(sms.body.includes(LINK));
  assert.match(sms.body, /STOP/, 'marketing opt-out line');
  assert.ok(sms.body.length <= 160, `one SMS (${sms.body.length} characters)`);
  assert.equal(sms.send_after, email.send_after);
  assert.ok(db.one('SELECT review_requested_at FROM contacts WHERE id = ?', c.id).review_requested_at);
});

test('clients who already reviewed, or opted out of marketing, are not asked', async () => {
  const reviewed = (await api.post('/contacts', { first_name: 'Rev', email: 'rev@example.com' })).data;
  const r = (await api.put(`/contacts/${reviewed.id}/google-review`, { reviewed: true })).data;
  assert.ok(r.google_reviewed_at);
  const before = db.one("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE 'How did we do%'").n;
  await settleFor(reviewed);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE 'How did we do%'").n, before);

  const optedOut = (await api.post('/contacts', { first_name: 'Quiet', email: 'quiet@example.com', mobile: '0400 000 003', marketing_opt_in: 0 })).data;
  await settleFor(optedOut);
  assert.match(runDetail(), /opted out of marketing/);
  const draft = (await api.get(`/contacts/${optedOut.id}/review-request`)).data;
  assert.match(draft.email_blocked, /opted out of marketing/);
  assert.equal((await api.post(`/contacts/${optedOut.id}/review-request`, { email: { subject: 'x', body: 'y' } })).status, 400);
});

test('one-off requests: email, SMS or both, with editable wording', async () => {
  const c = (await api.post('/contacts', { first_name: 'Olive', last_name: 'Once', email: 'olive@example.com', mobile: '0400 000 004' })).data;
  const noPhone = (await api.post('/contacts', { first_name: 'Nophone', email: 'np@example.com' })).data;
  const draft = (await api.get(`/contacts/${c.id}/review-request`)).data;
  assert.equal(draft.subject, 'How did we do, Olive?');
  assert.match(draft.body, /^Hi Olive,/);
  assert.match(draft.sms, new RegExp(`^Hi Olive, .*${LINK.replace(/[/.]/g, '\\$&')}`));
  assert.equal(draft.email_blocked, null);
  assert.equal(draft.review_requested_at, null);

  assert.equal((await api.post(`/contacts/${c.id}/review-request`, {})).status, 400);
  const smsOnly = await api.post(`/contacts/${c.id}/review-request`, { sms: { body: `Hi Olive, would you review us? ${LINK}` } });
  assert.equal(smsOnly.status, 201);
  assert.deepEqual(smsOnly.data.sent, ['SMS']);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM outbox WHERE contact_id = ? AND subject LIKE 'How did we do%'", c.id).n, 0);

  const both = await api.post(`/contacts/${c.id}/review-request`, { email: { subject: 'A quick favour', body: draft.body }, sms: { body: draft.sms } });
  assert.deepEqual(both.data.sent, ['email', 'SMS']);
  const sent = db.one("SELECT * FROM outbox WHERE contact_id = ? AND subject = 'A quick favour'", c.id);
  assert.equal(sent.status, 'logged', 'sent straight away (logged in tests)');
  const page = (await api.get(`/contacts/${c.id}`)).data;
  assert.ok(page.activities.some((a) => a.body === 'Google review requested by email and SMS'));
  assert.ok(page.review_requested_at);
  assert.equal((await api.get(`/contacts/${c.id}/review-request`)).data.days_since_asked, 0);

  assert.match((await api.get(`/contacts/${noPhone.id}/review-request`)).data.sms_blocked, /No mobile/);
  assert.equal((await api.post(`/contacts/${noPhone.id}/review-request`, { sms: { body: 'x' } })).status, 400);
  const otherDeal = db.one('SELECT id FROM deals LIMIT 1').id;
  assert.equal((await api.post(`/contacts/${noPhone.id}/review-request`, { email: { subject: 'x', body: 'y' }, deal_id: otherDeal })).status, 400);
  assert.equal((await api.post(`/contacts/${noPhone.id}/review-request`, { email: { subject: '', body: 'y' } })).status, 400);
});

test('marking a client as reviewed, and undoing it', async () => {
  const c = (await api.post('/contacts', { first_name: 'Mark' })).data;
  assert.ok((await api.put(`/contacts/${c.id}/google-review`, { reviewed: true })).data.google_reviewed_at);
  assert.ok((await api.get(`/contacts/${c.id}`)).data.activities.some((a) => a.body === 'Left a Google review'));
  assert.equal((await api.put(`/contacts/${c.id}/google-review`, { reviewed: false })).data.google_reviewed_at, null);
  assert.equal((await api.put('/contacts/99999/google-review', { reviewed: true })).status, 404);
});

test('upgrading: the old review email gets the button and SMS, and moves to its own automation', () => {
  const { addGoogleReviewDefaults } = require('../src/db/migrations');
  const { OLD_REVIEW_BODY } = require('../src/db/google-review-defaults');
  const t = db.one("SELECT id FROM email_templates WHERE name = 'Review request'");
  const settled = db.one("SELECT id, actions FROM automations WHERE name = 'Settled: congratulate, convert to client & book commissions'");
  db.update('email_templates', t.id, { body: OLD_REVIEW_BODY, sms_body: null });
  db.update('automations', settled.id, { actions: JSON.stringify([...JSON.parse(settled.actions), { type: 'send_email', template_id: t.id, delay_days: 14 }]) });
  db.run('DELETE FROM automations WHERE name = ?', AUTO);
  addGoogleReviewDefaults(db);
  addGoogleReviewDefaults(db);
  assert.match(db.one('SELECT body FROM email_templates WHERE id = ?', t.id).body, /Leave a Google review/);
  assert.ok(db.one('SELECT sms_body FROM email_templates WHERE id = ?', t.id).sms_body);
  assert.equal(JSON.parse(db.one('SELECT actions FROM automations WHERE id = ?', settled.id).actions).some((a) => a.template_id === t.id), false);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM automations WHERE name = ?', AUTO).n, 1);
  // A reworded template is left alone.
  db.update('email_templates', t.id, { body: 'My own words' });
  addGoogleReviewDefaults(db);
  assert.equal(db.one('SELECT body FROM email_templates WHERE id = ?', t.id).body, 'My own words');
});
