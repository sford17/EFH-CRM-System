'use strict';
// Calendly integration against a fake Calendly API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const TOKEN = 'eyJ-fake-calendly-personal-access-token';
const fake = { events: [], invitees: {}, base: '' };
const inDays = (d, hour = 10) => { const t = new Date(Date.now() + d * 86400000); t.setUTCHours(hour, 0, 0, 0); return t.toISOString(); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, fake.base);
  const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { title: 'Unauthenticated', message: 'The access token is invalid' });
  if (url.pathname === '/users/me') {
    return json(200, { resource: { uri: `${fake.base}/users/U1`, name: 'Admin User', email: 'admin@broker.example', scheduling_url: 'https://calendly.com/admin-efh' } });
  }
  if (url.pathname === '/event_types') {
    if (url.searchParams.get('user') !== `${fake.base}/users/U1`) return json(400, { message: 'bad user' });
    return json(200, {
      collection: [
        { name: 'Initial chat', duration: 15, active: true, scheduling_url: 'https://calendly.com/admin-efh/initial-chat' },
        { name: 'Loan review', duration: 30, active: true, scheduling_url: 'https://calendly.com/admin-efh/review' },
        { name: 'Secret', duration: 30, active: true, secret: true, scheduling_url: 'https://calendly.com/admin-efh/secret' },
      ],
      pagination: { next_page: null },
    });
  }
  if (url.pathname === '/scheduled_events') {
    // (Never assert in here: a throw would leave the request hanging.)
    if (!url.searchParams.get('min_start_time')) return json(400, { message: 'min_start_time required' });
    // Two pages to exercise pagination.
    const page = Number(url.searchParams.get('page') || 1);
    const half = Math.ceil(fake.events.length / 2);
    const slice = page === 1 ? fake.events.slice(0, half) : fake.events.slice(half);
    return json(200, { collection: slice, pagination: { next_page: page === 1 && fake.events.length > 1 ? `${fake.base}/scheduled_events?page=2&min_start_time=${url.searchParams.get('min_start_time')}` : null } });
  }
  const inv = url.pathname.match(/^\/scheduled_events\/([^/]+)\/invitees$/);
  if (inv) return json(200, { collection: fake.invitees[inv[1]] || [], pagination: {} });
  json(404, { message: 'not found' });
});

const event = (id, over = {}) => ({
  uri: `${fake.base}/scheduled_events/${id}`,
  name: 'Initial chat',
  status: 'active',
  start_time: inDays(2),
  end_time: inDays(2, 11),
  location: { type: 'zoom', join_url: 'https://zoom.us/j/123' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});
const invitee = (over = {}) => ({
  email: 'someone@example.com', name: 'Some One', first_name: 'Some', last_name: 'One', status: 'active',
  text_reminder_number: '+61400111222', cancel_url: 'https://calendly.com/cancellations/x', reschedule_url: 'https://calendly.com/reschedulings/x',
  questions_and_answers: [{ question: 'What would you like to discuss?', answer: 'Refinancing my home loan' }],
  tracking: {}, rescheduled: false, ...over,
});

let srv;
let api;
let db;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.base = `http://127.0.0.1:${server.address().port}`;
  process.env.CALENDLY_API_URL = fake.base;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(async () => { await srv.close(); server.close(); });

test('connecting checks the token and stores it encrypted', async () => {
  assert.equal((await api.post('/calendly/connect', { token: 'short' })).status, 400);
  assert.match((await api.post('/calendly/connect', { token: 'x'.repeat(40) })).data.error, /didn't accept that token/);
  // An existing booking from before connecting is imported quietly.
  const existing = (await api.post('/contacts', { first_name: 'Ex', email: 'existing@example.com', status: 'client' })).data;
  fake.events = [event('OLD', { start_time: inDays(1), created_at: '2020-01-01T00:00:00.000Z' })];
  fake.invitees.OLD = [invitee({ email: 'Existing@Example.com', name: 'Ex' })];
  const r = (await api.post('/calendly/connect', { token: TOKEN })).data;
  assert.equal(r.account.scheduling_url, 'https://calendly.com/admin-efh');
  assert.equal(r.sync.synced, 1);
  assert.equal(r.sync.new_events, 0, 'historic bookings do not fire automations');
  const stored = db.one('SELECT token FROM calendly_accounts');
  assert.ok(stored.token.startsWith('v1:') && !stored.token.includes(TOKEN));
  const appt = db.one("SELECT * FROM appointments WHERE external_uri LIKE '%/OLD'");
  assert.equal(appt.contact_id, existing.id, 'matched by email (case-insensitive)');
  assert.equal(appt.join_url, 'https://zoom.us/j/123');
});

test('new bookings link to contacts, create leads for strangers and fire automations', async () => {
  const known = (await api.post('/contacts', { first_name: 'Known', email: 'known@example.com', status: 'prospect' })).data;
  const deal = (await api.post('/deals', { contact_id: known.id, loan_amount: 400000 })).data;
  const viaLink = (await api.post('/contacts', { first_name: 'Linked', email: 'linked@work.example', status: 'lead' })).data;
  fake.events.push(event('A1', { name: 'Loan review' }), event('A2'), event('A3', { start_time: inDays(5) }));
  fake.invitees.A1 = [invitee({ email: 'known@example.com', name: 'Known' })];
  fake.invitees.A2 = [invitee({ email: 'brand.new@example.com', name: 'Brand New', first_name: 'Brand', last_name: 'New' })];
  // Booked from a CRM link but with a personal email: tracked back by utm_content.
  fake.invitees.A3 = [invitee({ email: 'linked.personal@gmail.example', tracking: { utm_source: 'efh-crm', utm_content: `crm-contact-${viaLink.id}` } })];

  const r = (await api.post('/calendly/sync')).data;
  assert.equal(r.new_events, 3);

  const a1 = db.one("SELECT * FROM appointments WHERE external_uri LIKE '%/A1'");
  assert.equal(a1.contact_id, known.id);
  assert.equal(a1.deal_id, deal.id, 'linked to the single open deal');
  assert.match(a1.notes, /Refinancing my home loan/);

  const lead = db.one("SELECT * FROM contacts WHERE email = 'brand.new@example.com'");
  assert.equal(lead.status, 'lead');
  assert.equal(lead.lead_source, 'calendly');
  assert.equal(lead.mobile, '+61400111222');
  assert.equal(db.one("SELECT contact_id FROM appointments WHERE external_uri LIKE '%/A2'").contact_id, lead.id);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM outbox WHERE to_email = 'brand.new@example.com'").n, 0, 'no "I\'ll call you" welcome email for people who already booked');

  assert.equal(db.one("SELECT contact_id FROM appointments WHERE external_uri LIKE '%/A3'").contact_id, viaLink.id);

  const task = db.one("SELECT * FROM tasks WHERE title LIKE 'Prepare for Loan review with Known%'");
  assert.ok(task, 'prep task created');
  assert.equal(task.due_date, require('../src/util').today(new Date(a1.start_at)), 'due on the meeting day');
  assert.ok((await api.get('/notifications')).data.rows.some((n) => /^New booking: Known/.test(n.message)));
  assert.ok((await api.get(`/contacts/${known.id}`)).data.activities.some((a) => a.type === 'meeting' && /Appointment booked: Loan review/.test(a.body)));

  // Unchanged events are not re-fetched or re-fired.
  assert.equal((await api.post('/calendly/sync')).data.new_events, 0);
});

test('cancellations fire follow-ups; reschedules do not', async () => {
  const a1 = fake.events.find((e) => e.uri.endsWith('/A1'));
  Object.assign(a1, { status: 'canceled', updated_at: new Date(Date.now() + 1000).toISOString(), cancellation: { reason: 'Found another broker' } });
  const a2 = fake.events.find((e) => e.uri.endsWith('/A2'));
  Object.assign(a2, { status: 'canceled', updated_at: new Date(Date.now() + 1000).toISOString() });
  fake.invitees.A2[0].rescheduled = true;
  await api.post('/calendly/sync');
  assert.ok(db.one("SELECT 1 AS x FROM tasks WHERE title LIKE 'Follow up – Known cancelled Loan review%' AND priority = 'high'"));
  assert.equal(db.one("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Follow up – Brand New%'").n, 0);
  const known = db.one("SELECT id FROM contacts WHERE email = 'known@example.com'");
  const acts = (await api.get(`/contacts/${known.id}`)).data.activities.map((a) => a.body);
  assert.ok(acts.some((b) => /Appointment cancelled: Loan review .*\(Found another broker\)/.test(b)));
  assert.equal(db.one("SELECT cancel_reason FROM appointments WHERE external_uri LIKE '%/A1'").cancel_reason, 'Found another broker');
});

test('appointments list, dashboard and contact record', async () => {
  const upcoming = (await api.get('/appointments?mine=1')).data.rows;
  assert.deepEqual(upcoming.map((a) => a.title), ['Initial chat', 'Initial chat'], 'cancelled hidden, sorted by time');
  assert.equal((await api.get('/appointments?include_cancelled=1')).data.rows.length, 4);
  const dash = (await api.get('/dashboard')).data;
  assert.equal(dash.appointments.length, 2);
  const lead = db.one("SELECT id FROM contacts WHERE email = 'brand.new@example.com'");
  assert.equal((await api.get(`/contacts/${lead.id}`)).data.appointments.length, 1);
});

test('booking links are pre-filled and tagged for the contact', async () => {
  const c = (await api.post('/contacts', { first_name: 'Pat', last_name: 'Lee', email: 'pat@example.com', status: 'lead' })).data;
  const { links } = (await api.get(`/calendly/links?contact_id=${c.id}`)).data;
  assert.deepEqual(links.map((l) => l.name), ['All my meeting types', 'Initial chat', 'Loan review'], 'secret event types hidden');
  const u = new URL(links[1].url);
  assert.equal(u.origin + u.pathname, 'https://calendly.com/admin-efh/initial-chat');
  assert.equal(u.searchParams.get('name'), 'Pat Lee');
  assert.equal(u.searchParams.get('email'), 'pat@example.com');
  assert.equal(u.searchParams.get('utm_content'), `crm-contact-${c.id}`);

  // Merge field for templates and automations.
  const { render, buildContext } = require('../src/services/templating');
  const user = db.one("SELECT id FROM users WHERE email = 'admin@test.local'");
  const out = render('Book here: {{broker.booking_link}}', buildContext({ contactId: c.id, userId: user.id }));
  assert.match(out, /^Book here: https:\/\/calendly\.com\/admin-efh\?name=Pat\+Lee&email=pat%40example\.com&utm_source=efh-crm&utm_content=crm-contact-\d+$/);
});

test('day-before reminders via the appointment_upcoming trigger', async () => {
  await api.post('/automations', {
    name: 'Meeting reminder SMS', trigger: 'schedule.appointment_upcoming', trigger_config: { days_before: 5 },
    actions: [{ type: 'create_task', title: 'Reminder: {{event.title}} with {{contact.first_name}} {{event.when}}' }],
  });
  const results = (await api.post('/automations/run-scheduled')).data.results.filter((r) => r.automation === 'Meeting reminder SMS');
  // Active appointments in the next 5 days: OLD (1 day) and A3 (5 days); A1/A2 were cancelled.
  assert.equal(results.length, 2);
  assert.match(results[0].entity, /^appointment:/);
  assert.equal((await api.post('/automations/run-scheduled')).data.results.filter((r) => r.automation === 'Meeting reminder SMS').length, 0);
});

test('a revoked token disconnects with a clear message', async () => {
  db.run('UPDATE calendly_accounts SET token = ?', require('../src/secrets').encrypt('revoked-token-xxxxxxxxxxxxxxxxxxxx'));
  const r = await api.post('/calendly/sync');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /reconnect/);
  const s = (await api.get('/calendly/status')).data.account;
  assert.equal(s.connected, false);
  assert.match(s.sync_error, /revoked/);
});
