'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ISSUE = {
  subject: 'October partner update: rates on hold, 5% deposits',
  preheader: 'A first home win, and what the RBA means for your clients',
  headline: 'Rates on hold and first home buyers are back',
  intro: 'Thanks for your referrals this month.',
  key_numbers: [{ label: 'Cash rate', value: '3.60%', note: 'Unchanged' }],
  updates: [
    {
      title: 'RBA holds rates', body: 'The RBA held the cash rate.\n\n- Lenders trimmed fixed rates',
      for_clients: 'Buyers can borrow a little more than last year.', chart: null,
      sources: [{ title: 'RBA holds', publisher: 'AFR', url: 'https://www.afr.com/rba' }, { title: 'bad', publisher: 'x', url: 'javascript:alert(1)' }],
    },
    { title: 'First Home Guarantee', body: 'Places are filling fast.', for_clients: 'First home buyers need only 5% deposit.', chart: { title: 'Places', unit: 'number', items: [{ label: 'NSW', value: 10000 }, { label: 'VIC', value: 9000 }] }, sources: [] },
  ],
  scenario: { title: 'From renting to owning with 5% down', body: 'A young couple renting in Parramatta thought they needed 20%.\n\nWe used the First Home Guarantee.', highlights: [{ label: 'Deposit', value: '5%' }, { label: 'Approved in', value: '6 days' }] },
  notes_for_broker: ['Check the places figure.'],
};
const STORY = { title: 'Nurses buy their first home', body: 'Two nurses renting in Parramatta bought a unit with a 5% deposit.', highlights: [{ label: 'Deposit', value: '5%' }] };

const requests = [];
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  const tool = body.tools.find((t) => t.name === 'save_story' || t.name === 'save_partner_newsletter').name;
  const input = tool === 'save_story' ? STORY : body.messages[0].content.includes('<notes>') ? ISSUE : { ...ISSUE, scenario: null };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4000, output_tokens: 1, server_tool_use: { web_search_requests: 4 } } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: tool, input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 700 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

let srv;
let api;
let db;
let pn;
const P = {};
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  pn = require('../src/services/partnerNewsletter');
});
after(() => { srv.close(); claude.close(); delete process.env.APP_URL; });

const waitReady = async (id) => {
  for (let i = 0; i < 60 && (await api.get(`/partner-newsletters/${id}`)).data.status === 'generating'; i += 1) await new Promise((x) => { setTimeout(x, 50); });
  return (await api.get(`/partner-newsletters/${id}`)).data;
};

test('setup: partners (some shouldn\'t get it) and a settled deal', async () => {
  const add = async (k, body) => { P[k] = (await api.post('/partners', body)).data; };
  await add('jane', { name: 'Jane Smith', company: 'Harbour Realty', type: 'real_estate', email: 'jane@harbour.example.com' });
  await add('acct', { name: 'Ali Accountant', type: 'accountant', email: 'ali@numbers.example.com' });
  await add('optout', { name: 'Olive Out', type: 'solicitor', email: 'olive@law.example.com', newsletter_opt_in: 0 });
  await add('inactive', { name: 'Ivan Gone', type: 'real_estate', email: 'ivan@example.com', active: 0 });
  await add('noemail', { name: 'Nora None', type: 'builder' });
  await add('dupe', { name: 'Jane Again', type: 'buyers_agent', email: 'JANE@harbour.example.com' });
  assert.deepEqual(pn.recipients().map((p) => p.name), ['Ali Accountant', 'Jane Smith'], 'opted-out, inactive, no-email and duplicate emails left out');

  const c = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Secret', email: 'mia.secret@example.com', employment_type: 'payg' })).data;
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  const d = (await api.post('/deals', { contact_id: c.id, loan_purpose: 'first_home', loan_amount: 741000, property_value: 780000, lender_id: wbc, property_address: '4/2 Smith St, Parramatta NSW 2150', referral_partner_id: P.jane.id, title: 'Mia first home' })).data;
  await api.post(`/deals/${d.id}/stage`, { stage: 'settled' });
});

test('without AI: the month is still started for you to fill in, with a reminder', async () => {
  const { id } = pn.generate('2026-08');
  const n = (await api.get(`/partner-newsletters/${id}`)).data;
  assert.equal(n.status, 'ready');
  assert.match(n.error, /AI isn't set up/);
  assert.deepEqual(n.missing, ['this month\'s client story', 'at least one industry update']);
  const mail = db.one('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(mail.subject, 'Reminder: add a client story to your August 2026 partner newsletter');
  assert.equal(mail.to_email, 'admin@test.local');
  assert.equal((await api.post(`/partner-newsletters/${id}/send`, {})).status, 400);
  assert.equal((await api.del(`/partner-newsletters/${id}`)).data.ok, true);
  await api.put('/ai/config', { api_key: 'sk-ant-api03-partnernews1234' });
});

test('ideas from settlements leave out names and addresses', async () => {
  const { rows } = (await api.get('/partner-newsletters/ideas')).data;
  assert.equal(rows.length, 1);
  assert.match(rows[0].notes, /^First home buyers bought in Parramatta \(property \$780,000\)\. Loan of \$741,000 \(95% LVR\) with Westpac\./);
  assert.doesNotMatch(rows[0].notes, /Mia|Secret|Smith St/);
  assert.equal(rows[0].referred_by, 'Jane Smith');
});

test('the client story: free text, saved early; AI can tidy it', async () => {
  const draft = (await api.post('/partner-newsletters/draft', { month: '2026-10' })).data;
  assert.equal(draft.status, 'draft');
  assert.equal((await api.post('/partner-newsletters/draft', { month: '2026-10' })).data.id, draft.id, 'one per month');
  const notes = 'Mia and Tom, both nurses, renting in Parramatta. Thought they needed 20%. First Home Guarantee: $780k unit, 5% down, approved in 6 days.';
  assert.equal((await api.put(`/partner-newsletters/${draft.id}/notes`, { notes })).data.scenario_notes, notes);

  assert.equal((await api.post('/partner-newsletters/polish', { notes: 'too short' })).status, 400);
  const story = (await api.post('/partner-newsletters/polish', { notes })).data;
  assert.deepEqual(story, STORY);
  const sent = requests.at(-1);
  assert.ok(!sent.tools.some((t) => t.type?.startsWith('web_')), 'no web search for tidying');
  assert.match(sent.system, /no real names/);
  assert.match(sent.messages[0].content, /<notes>\nMia and Tom/);
});

test('on the day: industry updates researched, story written from the notes, reminder emailed', async () => {
  const { id } = pn.generate('2026-10');
  const n = await waitReady(id);
  assert.equal(n.status, 'ready');
  const sent = requests.at(-1);
  assert.equal(sent.model, 'claude-opus-5-5');
  const search = sent.tools.find((t) => t.type === 'web_search_20260209');
  assert.ok(search.allowed_domains.includes('afr.com') && search.allowed_domains.includes('mpamag.com'));
  assert.equal(sent.tools.find((t) => t.name === 'save_partner_newsletter').strict, true);
  assert.match(sent.system, /referral partners: real estate agents/);
  assert.match(sent.messages[0].content, /<notes>\nMia and Tom/);

  const c = n.content;
  assert.equal(c.scenario.title, 'From renting to owning with 5% down');
  assert.equal(c.updates.length, 2);
  assert.equal(c.updates[0].sources.length, 1, 'bad link dropped');
  assert.equal(c.updates[1].chart.items.length, 2);
  assert.deepEqual(n.missing, []);
  const mail = db.one('SELECT * FROM outbox WHERE subject LIKE ? ORDER BY id DESC', '%October 2026 partner newsletter%');
  assert.equal(mail.subject, 'Your October 2026 partner newsletter is ready to review');
  assert.match(mail.body, /RBA holds rates/);
  assert.match(mail.body, /send it to your 2 referral partners/);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message = 'Your October 2026 partner newsletter is ready to review'"));
});

test('editing, the preview and a test send', async () => {
  const n = db.one("SELECT id FROM partner_newsletters WHERE month = '2026-10'");
  const cur = (await api.get(`/partner-newsletters/${n.id}`)).data.content;
  cur.scenario.body = 'Edited story about a couple in Parramatta.';
  cur.updates[0].for_clients = 'Edited <b>advice</b>.';
  const saved = (await api.put(`/partner-newsletters/${n.id}`, { content: cur })).data;
  assert.equal(saved.content.scenario.body, 'Edited story about a couple in Parramatta.');
  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${srv.base}/partner-newsletters/${n.id}/preview?partner_id=${P.jane.id}`, { headers: { Cookie: cookie } })).text();
  for (const s of ['October 2026 partner update', 'Hi Jane,', 'Client story: From renting to owning with 5% down', 'Edited story about a couple', 'Details changed to protect', 'Industry updates', 'For your clients:', 'Edited &lt;b&gt;advice&lt;/b&gt;.', 'Refer a client', 'mailto:admin@test.local?subject=Referral%20from%20Jane%20Smith']) {
    assert.ok(html.includes(s), `preview shows ${s}`);
  }
  const t = await api.post(`/partner-newsletters/${n.id}/test`, {});
  assert.equal(t.status, 200);
  assert.match(db.one('SELECT subject FROM outbox ORDER BY id DESC LIMIT 1').subject, /^\[Test\] October partner update/);
});

test('sending: each partner gets their own copy with an unsubscribe link', async () => {
  process.env.APP_URL = 'https://crm.example.com.au';
  const n = db.one("SELECT id FROM partner_newsletters WHERE month = '2026-10'");
  const r = await api.post(`/partner-newsletters/${n.id}/send`, { exclude: [P.acct.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  assert.equal(r.data.sent_count, 1);
  const out = db.all('SELECT * FROM outbox WHERE partner_newsletter_id = ?', n.id);
  assert.equal(out.length, 1);
  assert.equal(out[0].partner_id, P.jane.id);
  assert.match(out[0].body, /^OCTOBER 2026 PARTNER UPDATE/);
  assert.match(out[0].body, /Hi Jane,/);
  const link = /https:\/\/crm\.example\.com\.au\/api\/public\/partner-unsubscribe\?p=\d+&(?:amp;)?t=[\w-]{24}/.exec(out[0].html_body)[0].replace(/&amp;/g, '&');
  assert.equal((await api.post(`/partner-newsletters/${n.id}/send`, {})).status, 400, 'only once');

  const bad = await fetch(`${srv.base}/public/partner-unsubscribe?p=${P.jane.id}&t=${'x'.repeat(24)}`);
  assert.match(await bad.text(), /That link didn&#39;t work/);
  const ok = await fetch(link.replace('https://crm.example.com.au/api', srv.base));
  assert.match(await ok.text(), /You&#39;re unsubscribed/);
  assert.equal(db.one('SELECT newsletter_opt_in FROM referral_partners WHERE id = ?', P.jane.id).newsletter_opt_in, 0);
  assert.deepEqual(pn.recipients().map((p) => p.name), ['Ali Accountant', 'Jane Again'], 'Jane\'s other entry (same email) now gets it – one copy per address');
});

test('the schedule: a nudge 3 days before, then written on the day', async () => {
  assert.equal((await api.put('/partner-newsletters/settings', { day: 31 })).status, 400);
  assert.equal((await api.put('/partner-newsletters/settings', { types: [] })).status, 400);
  await api.put('/partner-newsletters/settings', { day: 20, types: ['real_estate', 'accountant'] });
  assert.deepEqual(pn.recipients().map((p) => p.name), ['Ali Accountant']);

  const before = db.one('SELECT COUNT(*) AS n FROM outbox').n;
  assert.equal(pn.tick('2026-11-16'), null);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM outbox').n, before, 'too early');
  pn.tick('2026-11-17');
  const nudge = db.one('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(nudge.subject, 'Your partner newsletter goes out soon: add a client story');
  assert.match(nudge.body, /written on the 20th/);
  pn.tick('2026-11-18');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM outbox').n, before + 1, 'nudged once');

  const run = pn.tick('2026-11-20');
  assert.ok(run, 'written on the day');
  await run.done;
  const n = db.one("SELECT * FROM partner_newsletters WHERE month = '2026-11'");
  assert.equal(n.status, 'ready');
  assert.equal(JSON.parse(n.content).scenario.body, '', 'no notes, so no story yet');
  assert.match(db.one('SELECT subject FROM outbox ORDER BY id DESC LIMIT 1').subject, /^Reminder: add a client story to your November 2026/);
  assert.equal(pn.tick('2026-11-21'), null, 'once a month');

  await api.put('/partner-newsletters/settings', { enabled: false });
  assert.equal(pn.tick('2026-12-20'), null);
});

test('partner opt-in shows on the partners list and can be changed', async () => {
  const rows = (await api.get('/partners')).data.rows;
  assert.equal(rows.find((p) => p.id === P.optout.id).newsletter_opt_in, 0);
  await api.patch(`/partners/${P.optout.id}`, { newsletter_opt_in: 1 });
  assert.equal(db.one('SELECT newsletter_opt_in FROM referral_partners WHERE id = ?', P.optout.id).newsletter_opt_in, 1);
});
