'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, db } = require('./helpers');
const { today, addDays, addMonths } = require('../src/util');

let srv;
let api;

before(async () => {
  srv = await startServer();
  api = srv.client();
  await api.login();
});
after(() => srv.close());

test('API requires a session', async () => {
  const anon = srv.client();
  assert.equal((await anon.get('/contacts')).status, 401);
  assert.equal((await anon.post('/auth/login', { email: 'admin@test.local', password: 'wrong' })).status, 401);
});

test('setup is refused once a user exists', async () => {
  const r = await srv.client().post('/auth/setup', { name: 'X', email: 'x@x.com', password: 'password123' });
  assert.equal(r.status, 409);
});

test('state-changing requests must be JSON (CSRF defence)', async () => {
  const r = await api.raw('POST', '/contacts', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
});

test('new lead triggers welcome email, call task and notification', async () => {
  const { status, data: c } = await api.post('/contacts', { first_name: 'Jane', last_name: 'Citizen', email: 'jane@example.com', status: 'lead', tags: null });
  assert.equal(status, 201);
  assert.equal(c.tags, '');
  const detail = (await api.get(`/contacts/${c.id}`)).data;
  assert.ok(detail.tasks.some((t) => t.title === 'Call Jane Citizen – new enquiry' && t.priority === 'high' && t.automation_id));
  assert.equal(detail.emails.length, 1);
  assert.match(detail.emails[0].subject, /Thanks for getting in touch, Jane/);
  const notes = (await api.get('/notifications')).data;
  assert.ok(notes.rows.some((n) => n.message === 'New lead: Jane Citizen'));
});

test('deal lifecycle: checklist, stage automations, settlement commissions', async () => {
  const lender = db.one("SELECT id FROM lenders WHERE name = 'ANZ'");
  const partner = (await api.post('/partners', { name: 'Agent A', type: 'real_estate', referral_fee_pct: 10 })).data;
  const contact = (await api.post('/contacts', { first_name: 'Bob', email: 'bob@example.com', status: 'prospect', employment_type: 'self_employed', referral_partner_id: partner.id })).data;
  const deal = (await api.post('/deals', { contact_id: contact.id, loan_purpose: 'purchase', loan_amount: 500000, property_value: 625000, lender_id: lender.id })).data;
  assert.equal(deal.stage, 'lead');
  assert.equal(deal.lvr, 80);
  assert.equal(deal.referral_partner_id, partner.id, 'inherits referral partner from contact');

  let d = (await api.get(`/deals/${deal.id}`)).data;
  assert.ok(d.documents.some((x) => x.name === 'Signed contract of sale'));
  assert.ok(d.documents.some((x) => x.name === '2 years company financials'), 'self-employed docs included');

  assert.equal((await api.post(`/deals/${deal.id}/stage`, { stage: 'fact_find' })).status, 200);
  d = (await api.get(`/deals/${deal.id}`)).data;
  const docEmail = db.one('SELECT * FROM outbox WHERE deal_id = ? AND subject LIKE ?', deal.id, 'Documents needed%');
  assert.ok(docEmail, 'document request email queued');
  assert.match(docEmail.body, /- Signed contract of sale/);

  assert.equal((await api.post(`/deals/${deal.id}/stage`, { stage: 'lost' })).status, 400, 'lost requires a reason');
  assert.equal((await api.post(`/deals/${deal.id}/stage`, { stage: 'bogus' })).status, 400);
  assert.equal((await api.post(`/deals/${deal.id}/documents`, { name: 'Evil', link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await api.post(`/deals/${deal.id}/documents`, { name: 'Payslip', link: 'https://drive.example/x' })).status, 201);

  const settleDate = today();
  await api.post(`/deals/${deal.id}/stage`, { stage: 'settled', settlement_date: settleDate });
  d = (await api.get(`/deals/${deal.id}`)).data;
  assert.equal(d.stage, 'settled');
  assert.equal(d.stage_history.length, 3);
  const upfront = d.commissions.find((x) => x.type === 'upfront');
  assert.equal(upfront.amount, 3250); // 0.65% of 500k
  assert.equal(d.commissions.find((x) => x.type === 'referral_fee').amount, -325);
  assert.equal(d.commissions.filter((x) => x.type === 'trail').length, 12);
  assert.equal(d.commissions.find((x) => x.type === 'trail').amount, 62.5); // 0.15% / 12

  const c = (await api.get(`/contacts/${contact.id}`)).data;
  assert.equal(c.status, 'client');
  assert.match(c.tags, /settled/);
  const review = db.one("SELECT * FROM outbox WHERE contact_id = ? AND subject LIKE 'How did we do%'", contact.id);
  assert.ok(review.send_after > new Date(Date.now() + 13 * 86400000).toISOString(), 'review request is delayed 14 days');

  // Generating again is a no-op.
  assert.equal((await api.post(`/deals/${deal.id}/commissions/generate`)).data.created, 0);
  const exposure = (await api.get('/commissions')).data.clawback_exposure;
  assert.ok(exposure.some((x) => x.id === deal.id));
});

test('scheduled automations fire once per record and date', async () => {
  const t0 = today();
  const lender = db.one("SELECT id FROM lenders WHERE name = 'NAB'");
  const contact = (await api.post('/contacts', { first_name: 'Fiona', email: 'fiona@example.com', status: 'client', dob: `1990-${t0.slice(5)}` })).data;
  const fixed = (await api.post('/deals', {
    contact_id: contact.id, loan_amount: 400000, lender_id: lender.id, rate_type: 'fixed', fixed_expiry_date: addDays(t0, 60),
  })).data;
  db.run("UPDATE deals SET stage = 'settled', settlement_date = ? WHERE id = ?", addMonths(t0, -24), fixed.id);

  const first = (await api.post('/automations/run-scheduled')).data.results;
  const names = first.map((r) => r.automation);
  assert.ok(names.includes('Fixed rate expiring in 90 days'));
  assert.ok(names.includes('Client birthday'));
  assert.ok(names.includes('Settlement anniversary: annual review'));
  assert.ok(db.one("SELECT 1 FROM tasks WHERE deal_id = ? AND title LIKE 'Fixed rate review:%'", fixed.id));

  const second = (await api.post('/automations/run-scheduled')).data.results;
  assert.equal(second.filter((r) => r.entity === `deal:${fixed.id}`).length, 0, 'not repeated');
});

test('stale lead and stale deal automations', async () => {
  const contact = (await api.post('/contacts', { first_name: 'Sleepy', email: 'sleepy@example.com', status: 'lead' })).data;
  const old = addDays(today(), -20);
  db.run('UPDATE contacts SET created_at = ? WHERE id = ?', `${old}T00:00:00.000Z`, contact.id);
  const deal = (await api.post('/deals', { contact_id: contact.id, loan_amount: 300000 })).data;
  db.run('UPDATE deals SET stage_changed_at = ? WHERE id = ?', `${old}T00:00:00.000Z`, deal.id);
  db.run("DELETE FROM activities WHERE deal_id = ? AND type != 'system'", deal.id);

  const results = (await api.post('/automations/run-scheduled')).data.results;
  assert.ok(results.some((r) => r.automation.startsWith('Uncontacted lead') && r.entity === `contact:${contact.id}`));
  assert.ok(results.some((r) => r.automation.startsWith('Stale deal') && r.entity === `deal:${deal.id}`));

  // Logging a call resets the stale-deal clock.
  await api.post(`/contacts/${contact.id}/activities`, { type: 'call', body: 'Spoke to client', deal_id: deal.id });
  const again = (await api.post('/automations/run-scheduled')).data.results;
  assert.ok(!again.some((r) => r.entity === `deal:${deal.id}`));
  assert.ok((await api.get(`/contacts/${contact.id}`)).data.last_contacted_at);
});

test('custom automation with conditions and validation', async () => {
  const bad = await api.post('/automations', { name: 'x', trigger: 'nope', actions: [] });
  assert.equal(bad.status, 400);
  const badAction = await api.post('/automations', { name: 'x', trigger: 'deal.created', actions: [{ type: 'send_email', template_id: 99999 }] });
  assert.equal(badAction.status, 400);

  const auto = (await api.post('/automations', {
    name: 'Big loans get priority',
    trigger: 'deal.created',
    conditions: [{ field: 'deal.loan_amount', op: 'gte', value: 1000000 }],
    actions: [{ type: 'add_tag', tag: 'high value' }, { type: 'create_task', title: 'Senior review for {{deal.title}}', due_in_days: 1 }],
  })).data;
  const contact = (await api.post('/contacts', { first_name: 'Rich', status: 'prospect' })).data;
  await api.post('/deals', { contact_id: contact.id, title: 'Small', loan_amount: 200000 });
  assert.equal(db.one('SELECT run_count FROM automations WHERE id = ?', auto.id).run_count, 0);
  await api.post('/deals', { contact_id: contact.id, title: 'Big', loan_amount: 1500000 });
  assert.equal(db.one('SELECT run_count FROM automations WHERE id = ?', auto.id).run_count, 1);
  assert.ok(db.one("SELECT 1 FROM tasks WHERE title = 'Senior review for Big'"));
  assert.match((await api.get(`/contacts/${contact.id}`)).data.tags, /high value/);

  await api.patch(`/automations/${auto.id}`, { enabled: 0 });
  await api.post('/deals', { contact_id: contact.id, title: 'Big 2', loan_amount: 2000000 });
  assert.equal(db.one('SELECT run_count FROM automations WHERE id = ?', auto.id).run_count, 1);
});

test('marketing emails respect opt-out', async () => {
  const contact = (await api.post('/contacts', { first_name: 'Nope', email: 'nope@example.com', status: 'client', marketing_opt_in: 0 })).data;
  const birthday = db.one("SELECT id FROM email_templates WHERE name = 'Birthday'");
  const r = await api.post(`/templates/${birthday.id}/send`, { contact_id: contact.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /opted out/);
});

test('template preview renders merge fields', async () => {
  const contact = (await api.post('/contacts', { first_name: 'Pat', status: 'prospect' })).data;
  const deal = (await api.post('/deals', { contact_id: contact.id, loan_amount: 750000, pre_approval_expiry: '2026-12-01' })).data;
  const t = db.one("SELECT id FROM email_templates WHERE name = 'Pre-approval obtained'");
  const p = (await api.post(`/templates/${t.id}/preview`, { deal_id: deal.id })).data;
  assert.match(p.body, /Hi Pat/);
  assert.match(p.body, /\$750,000/);
  assert.match(p.body, /1 December 2026/);
  assert.match(p.body, /Kind regards,$/, 'signature is added at send time, not in the template');
});

test('outbox processes due emails without SMTP', async () => {
  const r = (await api.post('/outbox/process')).data;
  assert.ok(r.processed > 0);
  const logged = db.one("SELECT COUNT(*) AS n FROM outbox WHERE status = 'logged'").n;
  assert.ok(logged > 0);
  assert.ok(db.one("SELECT 1 FROM activities WHERE type = 'email'"));
});

test('tasks: complete, filter, and task.completed event', async () => {
  const t = (await api.post('/tasks', { title: 'Do thing', due_date: addDays(today(), -1) })).data;
  const overdue = (await api.get('/tasks?due=overdue&assigned_to=me')).data.rows;
  assert.ok(overdue.some((x) => x.id === t.id));
  const done = (await api.patch(`/tasks/${t.id}`, { status: 'done' })).data;
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
});

test('CSV import and export', async () => {
  const csv = 'First Name,Last Name,Email,Status\nAmy,Lee,amy@example.com,lead\n"O\'Neil, Jr",,amy@example.com,lead\n,NoFirst,x@example.com,lead\n';
  const r = (await api.post('/contacts/import', { csv })).data;
  assert.equal(r.created, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.errors.length, 1);
  await api.post('/contacts', { first_name: '=HYPERLINK("x")', status: 'lead' });
  const out = await api.get('/contacts/export.csv');
  assert.match(out.data, /^id,first_name/);
  assert.match(out.data, /'=HYPERLINK/, 'formula injection neutralised');
});

test('calculators', async () => {
  const rep = (await api.post('/calculators/repayment', { loan_amount: 500000, interest_rate: 6, loan_term_years: 30 })).data;
  assert.equal(rep.payment, 2997.75);
  const lvr = (await api.post('/calculators/lvr', { property_value: 500000, loan_amount: 450000 })).data;
  assert.equal(lvr.lvr, 90);
  assert.equal(lvr.lmi_required, true);
  const bp = (await api.post('/calculators/borrowing-power', { applicant1_income: 100000, interest_rate: 6 })).data;
  assert.ok(bp.max_loan > 300000 && bp.max_loan < 700000, `plausible max loan ${bp.max_loan}`);
  const rf = (await api.post('/calculators/refinance', { loan_balance: 500000, remaining_years: 25, current_rate: 6.5, new_rate: 6, switching_costs: 1000 })).data;
  assert.ok(rf.monthly_saving > 0 && rf.breakeven_months > 0);
  assert.equal((await api.post('/calculators/repayment', { loan_amount: 0 })).status, 400);
  assert.equal((await api.post('/calculators/nope', {})).status, 404);
});

test('dashboard and reports respond', async () => {
  const d = (await api.get('/dashboard')).data;
  assert.ok(d.pipeline.count >= 0);
  assert.ok(Array.isArray(d.by_stage));
  const r = (await api.get('/reports')).data;
  assert.ok(Array.isArray(r.settlements_by_month));
  const s = (await api.get('/search?q=Jane')).data;
  assert.ok(s.contacts.length >= 1);
});

test('role permissions: assistants cannot manage users or settings', async () => {
  await api.post('/users', { name: 'Asst', email: 'asst@test.local', password: 'password123', role: 'assistant' });
  const asst = srv.client();
  await asst.login('asst@test.local', 'password123');
  assert.equal((await asst.post('/users', { name: 'Y', email: 'y@test.local', password: 'password123' })).status, 403);
  assert.equal((await asst.put('/settings', { business_name: 'Hacked' })).status, 403);
  assert.equal((await asst.get('/contacts')).status, 200);
});

test('admin cannot lock themselves out; deactivated users lose access', async () => {
  const me = (await api.get('/auth/me')).data.user;
  assert.equal((await api.patch(`/users/${me.id}`, { active: 0 })).status, 400);
  const u = (await api.post('/users', { name: 'Temp', email: 'temp@test.local', password: 'password123', role: 'broker' })).data;
  const temp = srv.client();
  await temp.login('temp@test.local', 'password123');
  await api.patch(`/users/${u.id}`, { active: 0 });
  assert.equal((await temp.get('/contacts')).status, 401);
});

test('login is rate limited after repeated failures', async () => {
  const anon = srv.client();
  for (let i = 0; i < 5; i++) await anon.post('/auth/login', { email: 'temp2@test.local', password: 'bad' });
  assert.equal((await anon.post('/auth/login', { email: 'temp2@test.local', password: 'bad' })).status, 429);
});
