'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let api;
let db;
let ff;
let household;
const { today, addMonths } = require('../src/util');
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  ff = require('../src/services/factFind');
  household = require('../src/services/household');
});
after(() => srv.close());

// The client's side: no sign-in, just the token.
const client = () => srv.client();
const tokenOf = (link) => link.split('/f/')[1];
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');

let mia;
let tom;
let deal;
let home;
let full;
let token;

test('setup: a couple with a deal and a mortgage tracker', async () => {
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Fact', email: 'mia.fact@example.com', mobile: '0400 000 001', status: 'prospect', marital_status: 'married', employment_type: 'payg', employer: 'Westpac', annual_income: 120000 })).data;
  tom = (await api.post('/contacts', { first_name: 'Tom', last_name: 'Fact', email: 'tom.fact@example.com' })).data;
  household.link(mia.id, tom.id, { relationship: 'spouse', shared_finances: true });
  home = (await api.post('/tracker/properties', { contact_id: mia.id, co_owner_id: tom.id, address: '5 Elm St, Ryde NSW 2112', valuation: { amount: 1200000, method: 'avm' } })).data;
  await api.post('/tracker/loans', { contact_id: mia.id, co_borrower_id: tom.id, lender_name: 'CBA', loan_type: 'home_loan', balance: 700000, interest_rate: 6.1, security_ids: [home.id] });
  deal = (await api.post('/deals', { contact_id: mia.id, loan_purpose: 'refinance', title: 'Mia refinance' })).data;
  await api.post(`/deals/${deal.id}/documents/checklist`, {});
});

test('sending a fact find: pre-filled from the CRM, emailed with a private link', async () => {
  const noEmail = (await api.post('/contacts', { first_name: 'Noemail' })).data;
  assert.match((await api.post('/fact-finds', { contact_id: noEmail.id, kind: 'full' })).data.error, /Add an email address for Noemail/);

  const r = await api.post('/fact-finds', { contact_id: mia.id, deal_id: deal.id, kind: 'full' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  full = r.data;
  token = tokenOf(full.link);
  assert.match(token, /^[\w-]{32}$/);
  assert.equal(full.status, 'sent');
  assert.equal(full.sent_to, 'mia.fact@example.com');
  assert.equal(full.reachability.public, false, 'localhost isn\'t reachable by clients');
  assert.ok(!db.one('SELECT token_enc FROM fact_finds WHERE id = ?', full.id).token_enc.includes(token), 'token stored encrypted');

  const a = full.answers;
  assert.equal(a.applying, 'joint');
  assert.deepEqual(a.applicants.map((p) => [p.first_name, p.crm_id]), [['Mia', mia.id], ['Tom', tom.id]]);
  assert.equal(a.applicants[0].jobs[0].type, 'full_time');
  assert.equal(a.applicants[0].jobs[0].employer, 'Westpac');
  assert.equal(a.properties[0].crm_id, home.id);
  assert.equal(a.properties[0].owner, 'joint');
  assert.equal(a.properties[0].value, '1200000');
  assert.equal(a.liabilities[0].lender, 'CBA');
  assert.equal(a.liabilities[0].property, a.properties[0].id, 'loan linked to its security');

  const mail = db.one('SELECT * FROM outbox WHERE contact_id = ? ORDER BY id DESC LIMIT 1', mia.id);
  assert.match(mail.subject, /Your fact find for/);
  assert.ok(mail.body.includes(full.link));
  assert.match(mail.html_body, /Start my fact find/);
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body = 'Online fact find sent to mia.fact@example.com'", mia.id));
});

test('the client page: branded, opens once, saves answers as they go', async () => {
  const c = client();
  assert.equal((await c.get('/public/fact-find/not-a-real-token-at-all-xxxxxxx')).status, 404);
  const page = await fetch(`${srv.base.replace(/\/api$/, '')}/f/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /factfind\/app\.js/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const v = (await c.get(`/public/fact-find/${token}`)).data;
  assert.equal(v.kind, 'full');
  assert.equal(v.first_name, 'Mia');
  assert.equal(v.brand.business_name, 'EFH Mortgage Broking');
  assert.match(v.brand.primary, /^#[0-9a-f]{6}$/i);
  assert.equal(v.broker.name, 'Admin User', 'no owner set: falls back to the sender');
  assert.ok(db.one('SELECT opened_at FROM fact_finds WHERE id = ?', full.id).opened_at);
  assert.equal(v.answers.applicants.length, 2);

  // The client fills it in.
  const a = v.answers;
  const [m, t] = a.applicants;
  Object.assign(m, { dob: '1990-04-12', residency: 'citizen', address: '5 Elm St', suburb: 'Ryde', state: 'NSW', postcode: '2112', living_situation: 'own_mortgage', address_since: '2020-03' });
  m.jobs[0] = { ...m.jobs[0], type: 'full_time', employer: 'Westpac', occupation: 'Analyst', start: '2025-07', base: '130000', base_freq: 'annually', extras: ['bonus'], bonus: '10000' };
  m.jobs.push({ id: 'prevjob', type: 'full_time', employer: 'ANZ', start: '2019-01', end: '2025-06', current: 'no' });
  m.other_income = [{ id: 'ftb', type: 'family_tax_a', amount: '200', freq: 'fortnightly' }];
  Object.assign(t, { last_name: 'Fact', dob: '1988-01-01', residency: 'visa', visa_subclass: '482', mobile: '0400 000 002' });
  t.jobs[0] = { id: 'tomjob', type: 'self_employed', business_name: 'Tom Tiling', entity: 'company', start: '2018-01', profit_recent: '90000', profit_prev: '80000', wages_recent: '50000' };
  a.household = { dependants: '2', dependant_ages: ['3', '6'] };
  a.goal = { purpose: 'refinance', refi_reasons: ['lower_rate', 'cash_out'], cash_out: '50000', equity_uses: ['renovate'], loan_amount: '750000', rate_pref: 'variable', changes: 'yes', changes_details: 'Parental leave next year', notes: 'Prefer an offset' };
  a.properties[0].value = '1300000';
  a.properties.push({ id: 'inv1', address: '9 Beach Rd, Manly NSW 2095', value: '900000', usage: 'investment', rent: '750', rent_freq: 'weekly', owner: m.id });
  a.liabilities[0] = { ...a.liabilities[0], balance: '690000', repayment: '4200', repayment_freq: 'monthly', rate: '6.1', rate_type: 'variable' };
  a.liabilities.push({ id: 'card1', type: 'credit_card', lender: 'Amex', limit: '15000', balance: '2000', owner: m.id });
  a.liabilities.push({ id: 'hecs1', type: 'hecs', balance: '18000', owner: t.id });
  a.assets = [{ id: 'sav1', type: 'savings', institution: 'ING', value: '40000', owner: 'joint' }, { id: 'sup1', type: 'superannuation', institution: 'AustralianSuper', value: '90000', owner: m.id }];
  a.expenses = { food_and_groceries: { amount: '1200', freq: 'monthly' }, transport: { amount: '100', freq: 'weekly' }, childcare: { amount: '800', freq: 'monthly' } };
  a.evil = '<script>alert(1)</script>'.repeat(2000);
  const saved = await c.put(`/public/fact-find/${token}`, { answers: a, step: 'documents' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const row = db.one('SELECT status, step, answers FROM fact_finds WHERE id = ?', full.id);
  assert.equal(row.status, 'in_progress');
  assert.equal(row.step, 'documents');
  assert.equal(JSON.parse(row.answers).evil.length, 4000, 'long text trimmed');
  assert.equal((await c.put(`/public/fact-find/${token}`, 'not json')).status, 400);
});

test('the document list adapts to the answers; uploads are checked', async () => {
  const c = client();
  const b = (await api.get(`/fact-finds/${full.id}`)).data;
  const keys = b.documents.map((d) => d.key);
  const labels = b.documents.map((d) => d.label).join('\n');
  assert.ok(keys.includes('payslips-' + b.answers.applicants[0].jobs[0].id));
  assert.match(labels, /Last 2 years' income statements/, 'bonus → income statements');
  assert.match(labels, /Centrelink income statement/, 'family tax benefit');
  assert.match(labels, /Passport and visa grant notice/);
  assert.ok(!keys.includes(`medicare-${b.answers.applicants[1].id}`), 'no Medicare for a visa holder');
  assert.match(labels, /business financial statements and business tax returns for Tom Tiling/);
  assert.match(labels, /Last 6 months' statements for your CBA home loan/, 'refinance → 6 months');
  assert.match(labels, /Current lease or last 3 months' rental statements for 9 Beach Rd/);
  assert.match(labels, /Latest council rates notice for 5 Elm St/);
  assert.match(labels, /Latest statement for your Amex credit card/);
  assert.match(labels, /Builder's quotes for the renovation/);
  assert.ok(!/HECS/.test(labels), 'no statement needed for HECS');

  const payslips = b.documents.find((d) => d.label.startsWith('Last 2 payslips'));
  assert.equal((await c.post(`/public/fact-find/${token}/files`, { doc_key: 'made-up', filename: 'x.pdf', data: PDF })).status, 400);
  const exe = await c.post(`/public/fact-find/${token}/files`, { doc_key: payslips.key, filename: 'payslip.pdf', data: Buffer.from('MZ\x90\x00 not a pdf').toString('base64') });
  assert.equal(exe.status, 415);
  const big = await c.post(`/public/fact-find/${token}/files`, { doc_key: payslips.key, filename: 'big.pdf', data: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(16 * 1024 * 1024)]).toString('base64') });
  assert.equal(big.status, 413);
  const up = await c.post(`/public/fact-find/${token}/files`, { doc_key: payslips.key, filename: '../../payslip june', data: PDF });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.filename, 'payslip june.pdf', 'path stripped, extension added');
  const photo = await c.post(`/public/fact-find/${token}/files`, { doc_key: b.documents.find((d) => d.key.startsWith('id-')).key, filename: 'licence.JPG', data: `data:image/jpeg;base64,${JPG}` });
  assert.equal(photo.status, 201);

  // The deal's checklist is ticked off and links to the file.
  const doc = db.one("SELECT status, link FROM documents WHERE deal_id = ? AND name = 'Last 2 payslips'", deal.id);
  assert.equal(doc.status, 'received');
  assert.equal(doc.link, `/api/fact-finds/files/${up.data.id}`);
  assert.equal(db.one("SELECT status FROM documents WHERE deal_id = ? AND name = 'Photo ID (driver licence / passport)'", deal.id).status, 'received');

  // The broker can view it; the client can remove their own upload.
  const file = await fetch(`${srv.base}/fact-finds/files/${up.data.id}`);
  assert.equal(file.status, 401, 'needs sign-in');
  const extra = await c.post(`/public/fact-find/${token}/files`, { doc_key: 'other', filename: 'extra.pdf', data: PDF });
  assert.equal((await c.del(`/public/fact-find/${token}/files/${extra.data.id}`)).data.ok, true);
  assert.equal((await c.del(`/public/fact-find/${token}/files/${up.data.id + 999}`)).status, 404);
});

test('submitting: needs the declaration; tells the broker; runs automations; locks the answers', async () => {
  const c = client();
  const v = (await c.get(`/public/fact-find/${token}`)).data;
  const bad = await c.post(`/public/fact-find/${token}/submit`, { answers: v.answers });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /the declaration, your name as your signature/);
  v.answers.declaration = { privacy: true, true_and_correct: true, signature: 'Mia Fact, Tom Fact' };
  const ok = await c.post(`/public/fact-find/${token}/submit`, { answers: v.answers });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = db.one('SELECT status, submitted_at FROM fact_finds WHERE id = ?', full.id);
  assert.equal(row.status, 'submitted');
  assert.ok(db.one("SELECT 1 FROM tasks WHERE title = 'Review Mia''s online fact find and documents'"), 'seeded automation made a review task');
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body LIKE 'Client completed their online fact find (% documents still to come)'", mia.id));
  assert.equal((await c.put(`/public/fact-find/${token}`, { answers: v.answers })).status, 400, 'locked');
  assert.equal((await c.post(`/public/fact-find/${token}/submit`, {})).status, 400, 'only once');
  // Documents can still be added afterwards.
  assert.equal((await c.post(`/public/fact-find/${token}/files`, { doc_key: 'other', filename: 'late.pdf', data: PDF })).status, 201);

  const list = (await api.get('/fact-finds?status=submitted')).data.rows;
  assert.equal(list[0].id, full.id);
  assert.equal(list[0].progress, 100);
  assert.ok(list[0].documents > 10);
  assert.equal(list[0].documents_received, 2);
});

test('the broker reviews it: summary, files and a PDF', async () => {
  const b = (await api.get(`/fact-finds/${full.id}`)).data;
  const titles = b.summary.map((s) => s.title);
  assert.deepEqual(titles, ['About you both', 'Work and income', 'What you\'d like to do', 'What you own', 'What you owe', 'Living expenses']);
  const flat = JSON.stringify(b.summary);
  assert.match(flat, /Temporary visa \(subclass 482\)/);
  assert.match(flat, /Parental leave next year/);
  assert.match(flat, /About \$2,433 a month/, '1200 + 100 weekly + 800');
  const fileId = b.documents.find((d) => d.files.length).files[0].id;
  const res = await api.raw('GET', `/fact-finds/files/${fileId}`);
  assert.equal(res.status, 200);
  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const dl = await fetch(`${srv.base}/fact-finds/files/${fileId}?download=1`, { headers: { Cookie: cookie } });
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  const pdf = await fetch(`${srv.base}/fact-finds/${full.id}/pdf`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('importing into the CRM: contacts, household, tracker, deal and Quickli', async () => {
  const r = await api.post(`/fact-finds/${full.id}/import`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const m = db.one('SELECT * FROM contacts WHERE id = ?', mia.id);
  assert.deepEqual([m.dob, m.employment_type, m.employer, m.dependants, m.state], ['1990-04-12', 'payg', 'Westpac', 2, 'NSW']);
  assert.equal(m.annual_income, 130000 + 10000 + 5200);
  assert.deepEqual(JSON.parse(m.income_details), { payg: 130000, recent_year_bonus: 10000, family_tax_a: 5200 });
  assert.deepEqual(JSON.parse(m.living_expenses), { food_and_groceries: 1200, transport: 433.33, childcare: 800 });
  const t = db.one('SELECT * FROM contacts WHERE id = ?', tom.id);
  assert.equal(t.employment_type, 'self_employed');
  assert.equal(JSON.parse(t.self_employed)[0].business, 'Tom Tiling');
  assert.equal(db.all('SELECT * FROM contacts WHERE first_name = ? AND last_name = ?', 'Tom', 'Fact').length, 1, 'partner updated, not duplicated');

  const props = db.all('SELECT * FROM properties WHERE contact_id = ? ORDER BY id', mia.id);
  assert.deepEqual(props.map((p) => p.address), ['5 Elm St, Ryde NSW 2112', '9 Beach Rd, Manly NSW 2095']);
  assert.equal(props[0].co_owner_id, tom.id);
  assert.equal(props[1].usage, 'investment');
  assert.equal(props[1].rental_income_weekly, 750);
  const vals = db.all("SELECT amount FROM valuations WHERE method = 'client_estimate' ORDER BY id");
  assert.deepEqual(vals.map((v) => v.amount), [1300000, 900000], 'new client estimates');
  const loans = db.all('SELECT * FROM loans ORDER BY id');
  assert.equal(loans.length, 3, 'existing home loan updated, card and HECS added');
  assert.equal(loans[0].balance, 690000);
  assert.equal(loans[0].repayment_amount, 4200);
  assert.deepEqual(loans.slice(1).map((l) => [l.loan_type, l.lender_name, l.arranged_by_us]), [['credit_card', 'Amex', 0], ['hecs', 'HECS-HELP / student loan', 0]]);
  assert.equal(loans[2].contact_id, tom.id);
  const assets = db.all('SELECT * FROM client_assets ORDER BY id');
  assert.deepEqual(assets.map((x) => [x.asset_type, x.institution, x.value]), [['savings', 'ING', 40000], ['superannuation', 'AustralianSuper', 90000]]);
  const d = db.one('SELECT * FROM deals WHERE id = ?', deal.id);
  assert.deepEqual([d.loan_purpose, d.loan_amount, d.co_borrower_id], ['refinance', 750000, tom.id]);
  assert.match(db.one("SELECT body FROM activities WHERE contact_id = ? AND body LIKE 'Online fact find imported%'", mia.id).body, /Expected changes affecting repayments: Parental leave next year/);
  assert.equal(db.one('SELECT status FROM fact_finds WHERE id = ?', full.id).status, 'reviewed');

  // Importing again updates the same records.
  await api.post(`/fact-finds/${full.id}/import`, {});
  assert.equal(db.all('SELECT 1 FROM properties').length, 2);
  assert.equal(db.all('SELECT 1 FROM loans').length, 3);
  assert.equal(db.all('SELECT 1 FROM client_assets').length, 2);
  assert.equal(db.all("SELECT 1 FROM valuations WHERE method = 'client_estimate'").length, 2, 'no repeat valuations');

  // Quickli gets the declared expenses, income breakdown and business figures.
  const q = require('../src/services/quickli').buildScenario(deal.id);
  assert.equal(q.scenario.living_expenses[0].use_detailed_basic_expense, true);
  assert.equal(q.scenario.living_expenses[0].food_and_groceries, 1200);
  const inc = q.scenario.income.find((i) => i.name === 'Mia Fact');
  assert.deepEqual([inc.payg, inc.recent_year_bonus, inc.use_simple_bonus, inc.family_tax_a], [130000, 10000, true, 5200]);
  assert.equal(q.scenario.self_employed_income[0].entity_type, 'company');
  assert.equal(q.scenario.self_employed_income[0].most_recent_year_details.net_profit_before_tax, 90000);
  assert.ok(!q.warnings.some((w) => /Living expenses aren't recorded/.test(w)));

  // The next fact find starts from these answers.
  const again = ff.prefill(mia.id);
  assert.equal(again.goal.notes, 'Prefer an offset');
  assert.deepEqual(again.declaration, {});
});

test('documents only: the broker chooses; no declaration needed', async () => {
  assert.equal((await api.post('/fact-finds', { contact_id: mia.id, kind: 'documents', requests: [] })).status, 400);
  const r = (await api.post('/fact-finds', { contact_id: mia.id, kind: 'documents', requests: ['Last 2 payslips', 'Last 2 payslips', { label: 'Letter from your employer', note: 'confirming your return date' }], send: true })).data;
  assert.equal(r.documents.length, 2, 'duplicates removed');
  const mail = db.one('SELECT body FROM outbox WHERE contact_id = ? ORDER BY id DESC LIMIT 1', mia.id);
  assert.match(mail.body, /- Letter from your employer \(confirming your return date\)/);
  const c = client();
  const tk = tokenOf(r.link);
  const v = (await c.get(`/public/fact-find/${tk}`)).data;
  assert.equal(v.answers, null);
  assert.equal(v.requests.length, 2);
  assert.equal((await c.put(`/public/fact-find/${tk}`, { answers: {} })).status, 400);
  assert.equal((await c.post(`/public/fact-find/${tk}/files`, { doc_key: v.requests[0].key, filename: 'p.pdf', data: PDF })).status, 201);
  assert.equal((await c.post(`/public/fact-find/${tk}/submit`, {})).status, 200);
  assert.equal((await api.post(`/fact-finds/${r.id}/import`, {})).status, 400);
  assert.equal((await api.post(`/fact-finds/${r.id}/reviewed`, {})).data.status, 'reviewed');
});

test('expired and cancelled links stop working; reminders go out automatically', async () => {
  const r = (await api.post('/fact-finds', { contact_id: tom.id, kind: 'full' })).data;
  const c = client();
  const tk = tokenOf(r.link);
  db.run('UPDATE fact_finds SET expires_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', r.id);
  assert.equal((await c.get(`/public/fact-find/${tk}`)).status, 410);
  await api.post(`/fact-finds/${r.id}/extend`, { days: 7 });
  assert.equal((await c.get(`/public/fact-find/${tk}`)).status, 200);

  db.run('UPDATE fact_finds SET created_at = ?, last_saved_at = NULL WHERE id = ?', new Date(Date.now() - 4 * 86400000).toISOString(), r.id);
  const before = db.one('SELECT COUNT(*) AS n FROM outbox').n;
  assert.equal(ff.tick(), 1);
  assert.equal(ff.tick(), 0, 'not again straight away');
  const mail = db.one('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM outbox').n, before + 1);
  assert.match(mail.subject, /^Reminder: your fact find/);
  assert.match(mail.body, /Your answers are saved/);

  await api.post(`/fact-finds/${r.id}/cancel`, {});
  assert.equal((await c.get(`/public/fact-find/${tk}`)).status, 404);
  assert.equal((await api.del(`/fact-finds/${r.id}`)).data.ok, true);
});

test('automation: moving a deal to Fact Find can send it', async () => {
  const auto = db.one("SELECT * FROM automations WHERE name = 'Fact Find stage: send the online fact find'");
  assert.equal(auto.enabled, 0, 'off until switched on');
  db.run('UPDATE automations SET enabled = 1 WHERE id = ?', auto.id);
  const zoe = (await api.post('/contacts', { first_name: 'Zoe', email: 'zoe.ff@example.com' })).data;
  const d = (await api.post('/deals', { contact_id: zoe.id, loan_purpose: 'purchase', title: 'Zoe purchase' })).data;
  await api.post(`/deals/${d.id}/stage`, { stage: 'fact_find' });
  const sent = db.one('SELECT * FROM fact_finds WHERE contact_id = ?', zoe.id);
  assert.ok(sent, 'fact find created');
  assert.equal(sent.deal_id, d.id);
  assert.equal(sent.sent_to, 'zoe.ff@example.com');
  // Not twice while one is open.
  await api.post(`/deals/${d.id}/stage`, { stage: 'lead' });
  await api.post(`/deals/${d.id}/stage`, { stage: 'fact_find' });
  assert.equal(db.all('SELECT 1 FROM fact_finds WHERE contact_id = ?', zoe.id).length, 1);
});

test('file types are checked by their contents', () => {
  assert.equal(ff.sniff(Buffer.from('%PDF-1.7'), 'a.pdf'), 'pdf');
  assert.equal(ff.sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a.png'), 'png');
  assert.equal(ff.sniff(Buffer.from('PK\x03\x04xxxx'), 'a.docx'), 'docx');
  assert.equal(ff.sniff(Buffer.from('PK\x03\x04xxxx'), 'a.zip'), null);
  assert.equal(ff.sniff(Buffer.from('<html><script>'), 'a.pdf'), null);
  assert.equal(today().length, 10);
  assert.ok(addMonths(today(), 1));
});
