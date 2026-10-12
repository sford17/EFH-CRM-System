'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
let db;
let automation;
let reminders;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  automation = require('../src/services/automation');
  reminders = require('../src/services/reminders');
});
after(() => srv.close());

const { today, addDays, addMonths } = require('../src/util');
const T = today();
let admin;
let mia;
let tom;
let jack;

test('next anniversary: wraps the year, handles 29 February, never the original date', () => {
  assert.equal(reminders.nextAnniversary('2023-10-20', '2026-10-12'), '2026-10-20');
  assert.equal(reminders.nextAnniversary('2023-01-05', '2026-12-25'), '2027-01-05');
  assert.equal(reminders.nextAnniversary('2024-02-29', '2027-02-01'), '2027-02-28');
  assert.equal(reminders.nextAnniversary('2028-02-29', '2028-02-01'), '2029-02-28', 'not the settlement day itself');
  assert.equal(reminders.nextAnniversary('2026-10-20', '2026-10-12'), '2027-10-20');
});

test('the reminder automation is installed, on, 14 days ahead', () => {
  const a = db.one("SELECT * FROM automations WHERE name = 'Annual review coming up: email me'");
  assert.equal(a.enabled, 1);
  assert.equal(a.trigger, 'schedule.annual_review');
  assert.deepEqual(JSON.parse(a.trigger_config), { days_before: 14 });
});

test('setup: clients with review dates and settlement anniversaries', async () => {
  admin = db.one("SELECT id FROM users WHERE email = 'admin@test.local'").id;
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com', mobile: '0455 555 555', status: 'client', next_review_date: addDays(T, 14) })).data;
  tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom', email: 'tom@example.com' }, relationship: 'spouse', shared_finances: 1 })).data;
  db.run('UPDATE contacts SET next_review_date = ? WHERE id = ?', addDays(T, 14), tom.related_id);
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  await api.post('/tracker/loans', { contact_id: mia.id, lender_id: wbc, loan_type: 'home_loan', balance: 600000, rate_type: 'fixed', interest_rate: 5.69, fixed_expiry_date: addDays(T, 90) });

  // Jack has no review date: his settlement anniversary is used.
  jack = (await api.post('/contacts', { first_name: 'Jack', last_name: 'Williams', status: 'client' })).data;
  const settledOn = addDays(addMonths(T, -24), 10);
  db.insert('deals', { contact_id: jack.id, title: 'Jack – purchase', stage: 'settled', settlement_date: settledOn, owner_id: admin });

  // Not due yet, lost, or already passed.
  await api.post('/contacts', { first_name: 'Later', status: 'client', next_review_date: addDays(T, 40) });
  await api.post('/contacts', { first_name: 'Lost', status: 'lost', next_review_date: addDays(T, 5) });
  await api.post('/contacts', { first_name: 'Overdue', status: 'client', next_review_date: addDays(T, -3) });
});

test('who is due: review dates and anniversaries within 14 days, one per household', () => {
  const rows = reminders.annualReviewsDue({ days_before: 14 }, T);
  const names = rows.map((r) => db.one('SELECT first_name FROM contacts WHERE id = ?', r.contactId).first_name);
  assert.deepEqual(names.sort(), ['Jack', 'Mia']);
  const jackRow = rows.find((r) => r.contactId === jack.id);
  assert.equal(jackRow.event.when, 'in 10 days');
  assert.equal(jackRow.event.review_source, 'settlement anniversary');
  assert.equal(rows.find((r) => r.contactId === mia.id).event.when, 'in 14 days');
});

test('the broker gets one email per review, with a snapshot of the client', async () => {
  automation.runScheduled(T);
  automation.runScheduled(T); // no duplicates on the next run
  const emails = db.all("SELECT * FROM outbox WHERE subject LIKE 'Annual review due%' ORDER BY id");
  assert.equal(emails.length, 2);
  const m = emails.find((e) => e.contact_id === mia.id);
  assert.equal(m.to_email, 'admin@test.local');
  assert.equal(m.internal, 1);
  assert.equal(m.subject, 'Annual review due in 14 days: Mia Jones');
  assert.match(m.body, /^Hi Admin,\n\nMia Jones's annual review is due in 14 days \(/);
  assert.match(m.body, /- Mia Jones: 0455 555 555 · mia@example.com\n- Tom Jones: tom@example.com/);
  assert.match(m.body, /- Last review: none on file/);
  assert.match(m.body, /- Fixed rate ends .*: Westpac home loan \(\$600,000\)/);
  assert.match(m.body, /\[\[position\]\]\n\n\[\[lending_structure\]\]\n\n\[\[button: Open Mia in the CRM \| http:\/\/localhost:\d+\/#\/contacts\/\d+\?tab=tracker\]\]$/);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE user_id = ? AND message = 'Annual review due in 14 days: Mia Jones'", admin), 'bell notification too');

  // Built as a branded email without a signature.
  const { buildEmail } = require('../src/services/emailHtml');
  const built = buildEmail({ body: m.body, internal: true, context: { contactId: m.contact_id } });
  assert.match(built.html, />Position at a glance</, 'headings worded for the broker');
  assert.doesNotMatch(built.html, /Your position|How your lending/);
  assert.match(built.html, /Open Mia in the CRM<\/a>/);
  assert.doesNotMatch(built.text, /Admin User\n/, 'no signature');
});

test('reminders are not filed on the client\'s timeline', async () => {
  await require('../src/services/mailer').processOutbox();
  const m = db.one("SELECT * FROM outbox WHERE subject LIKE 'Annual review due%' AND contact_id = ?", mia.id);
  assert.equal(m.status, 'logged');
  const c = (await api.get(`/contacts/${mia.id}`)).data;
  assert.equal(c.activities.some((a) => /Annual review due/.test(a.body)), false);
  assert.equal(c.emails.some((e) => /Annual review due/.test(e.subject)), false);
  const outbox = (await api.get('/outbox')).data.rows.find((r) => r.id === m.id);
  assert.equal(outbox.internal, 1);
});

test('custom wording, a chosen team member, and message-only reminders', async () => {
  const jordan = (await api.post('/users', { name: 'Jordan Lee', email: 'jordan@test.local', password: 'password123', role: 'broker' })).data;
  const ctx = require('../src/services/templating').buildContext({ contactId: jack.id });
  ctx.event = { when: 'in 3 days', review_date: addDays(T, 3) };
  const r = reminders.emailBroker({ user: String(jordan.id), subject: 'Prep {{contact.full_name}}', message: 'Review {{event.when}}.', details: 'none' }, ctx);
  const row = db.one('SELECT * FROM outbox WHERE id = ?', r.id);
  assert.equal(row.to_email, 'jordan@test.local');
  assert.equal(row.subject, 'Prep Jack Williams');
  assert.match(row.body, /^Review in 3 days\.\n\n\[\[button: Open Jack in the CRM \| /);
  // Inactive users aren't emailed.
  await api.patch(`/users/${jordan.id}`, { active: 0 });
  assert.match(reminders.emailBroker({ user: String(jordan.id) }, ctx).reason, /no active broker/);
});

test('the CRM web address setting is used for links, and checked', async () => {
  assert.equal((await api.put('/settings', { app_url: 'crm dot com' })).status, 400);
  assert.equal((await api.put('/settings', { app_url: 'https://crm.efh.example/' })).status, 200);
  assert.equal(reminders.crmUrl('#/contacts/5'), 'https://crm.efh.example/#/contacts/5');
});

test('imported clients already due are held, not emailed', () => {
  const late = db.insert('contacts', { first_name: 'Imported', status: 'client', next_review_date: addDays(T, 2) });
  const held = automation.markScheduledDone({ contactIds: [late] }, 'Imported');
  assert.ok(held >= 1);
  automation.runScheduled(T);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM outbox WHERE subject LIKE 'Annual review due%' AND contact_id = ?", late).n, 0);
});

test('upgrading adds the automation once', () => {
  const { addReviewReminderDefaults } = require('../src/db/migrations');
  db.run("DELETE FROM automations WHERE name = 'Annual review coming up: email me'");
  addReviewReminderDefaults(db);
  addReviewReminderDefaults(db);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM automations WHERE name = 'Annual review coming up: email me'").n, 1);
});
