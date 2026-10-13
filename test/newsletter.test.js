'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const NEWSLETTER = {
  subject: 'October: rates on hold and spring selling season heats up',
  preheader: 'What the RBA decision means for you, plus how your rate compares',
  headline: 'Rates on hold as spring lifts property prices',
  intro: 'The Reserve Bank held the cash rate this month.\n\nHere is what that means for your home loan.',
  key_numbers: [
    { label: 'Cash rate', value: '3.60%', note: 'Unchanged' },
    { label: 'Home values', value: '+0.8%', note: 'National, September' },
    { label: 'Avg variable rate', value: '5.90%', note: 'Owner-occupiers' },
  ],
  sections: [
    {
      title: 'Interest rates', body: 'The RBA left rates on hold.\n\n- Most economists expect a cut early next year\n- Fixed rates have eased',
      chart: null, sources: [{ title: 'RBA holds rates', publisher: 'AFR', url: 'https://www.afr.com/policy/economy/rba-holds' }, { title: 'bad', publisher: 'x', url: 'javascript:alert(1)' }],
    },
    {
      title: 'Property market', body: 'Home values rose again in September.',
      chart: { title: 'Home value change, September', unit: '%', items: [{ label: 'Sydney', value: 0.6 }, { label: 'Perth', value: 1.4 }, { label: 'Hobart', value: -0.3 }] },
      sources: [{ title: 'Home value index', publisher: 'Cotality', url: 'https://www.cotality.com.au/hvi' }],
    },
  ],
  market_rates: { owner_occupier_variable: 5.9, investor_variable: 6.15, owner_occupier_fixed: 5.6, investor_fixed: null, as_at: 'August 2026', source_name: 'RBA', source_url: 'https://www.rba.gov.au/statistics/tables/' },
  notes_for_broker: ['Check the Perth figure against the latest index.'],
};

// A stand-in Claude: first a research turn that pauses, then a turn that
// forgets to save, then the save_newsletter call.
const requests = [];
let script = [];
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  const step = script.shift() || 'save';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5000, output_tokens: 1, server_tool_use: { web_search_requests: 3 } } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step === 'save' ? 'Here is the newsletter.' : 'Researching this month\'s news…' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  let stop = step === 'pause' ? 'pause_turn' : 'end_turn';
  if (step === 'save') {
    send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_newsletter', input: {} } });
    const json = JSON.stringify(NEWSLETTER);
    for (let i = 0; i < json.length; i += 50) send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 50) } });
    send('content_block_stop', { type: 'content_block_stop', index: 1 });
    stop = 'tool_use';
  }
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 900 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

let srv;
let api;
let db;
let newsletter;
let issueId;
const people = {};
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  newsletter = require('../src/services/newsletter');
});
after(() => { srv.close(); claude.close(); });

test('setup: clients with loans, an opt-out, a lead and a shared email', async () => {
  const make = async (k, body) => { people[k] = (await api.post('/contacts', body)).data; };
  await make('mia', { first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com', status: 'client' });
  await make('noah', { first_name: 'Noah', last_name: 'Smith', email: 'noah@example.com', status: 'client' });
  await make('zoe', { first_name: 'Zoe', last_name: 'Clarke', email: 'zoe@example.com', status: 'client', marketing_opt_in: 0 });
  await make('liam', { first_name: 'Liam', last_name: 'Wilson', email: 'liam@example.com', status: 'lead' });
  await make('tom', { first_name: 'Tom', last_name: 'Jones', email: 'MIA@example.com', status: 'client' });
  await api.post('/tracker/loans', { contact_id: people.mia.id, lender_name: 'Westpac', loan_type: 'home_loan', limit_amount: 600000, balance: 580000, interest_rate: 6.24, rate_type: 'variable' });
  await api.post('/tracker/loans', { contact_id: people.mia.id, lender_name: 'ANZ', loan_type: 'investment_loan', limit_amount: 400000, balance: 400000, interest_rate: 5.95, rate_type: 'variable' });
  await api.post('/tracker/loans', { contact_id: people.noah.id, lender_name: 'CBA', loan_type: 'home_loan', limit_amount: 500000, balance: 500000, interest_rate: 5.49, rate_type: 'fixed', fixed_expiry_date: '2027-06-30' });
  const r = (await api.get('/newsletters/recipients')).data.rows;
  assert.deepEqual(r.map((x) => x.email), ['mia@example.com', 'noah@example.com'], 'opted-out, leads and duplicate emails left out');
});

test('generating needs AI set up', async () => {
  const r = await api.post('/newsletters/generate', {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /AI isn't set up/);
  await api.put('/ai/config', { api_key: 'sk-ant-api03-newslettertest1234' });
});

test('the scheduler writes it on the 20th: researching, pausing, then saving', async () => {
  const month = newsletter.currentMonth();
  assert.equal(newsletter.tick(`${month}-19`), null, 'not before the day');
  script = ['pause', 'forgot', 'save'];
  const started = newsletter.tick(`${month}-20`);
  assert.ok(started, 'started on the 20th');
  issueId = started.id;
  assert.equal(newsletter.get(issueId).status, 'generating');
  assert.equal(newsletter.tick(`${month}-21`), null, 'only once a month');
  await started.done;

  assert.equal(requests.length, 3);
  const first = requests[0];
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.fallbacks, 'default');
  assert.equal(first.stream, true);
  const search = first.tools.find((t) => t.name === 'web_search');
  assert.equal(search.type, 'web_search_20260209');
  assert.ok(search.allowed_domains.includes('afr.com'));
  assert.equal(search.user_location.country, 'AU');
  assert.equal(first.tools.find((t) => t.name === 'web_fetch').type, 'web_fetch_20260209');
  const save = first.tools.find((t) => t.name === 'save_newsletter');
  assert.equal(save.strict, true);
  assert.equal(save.eager_input_streaming, true);
  assert.match(first.system, /afr\.com/);
  // After a pause the turn is resumed as is; after a turn with no save, it's asked to save.
  assert.equal(requests[1].messages.at(-1).role, 'assistant');
  assert.equal(requests[2].messages.at(-1).role, 'user');
  assert.match(requests[2].messages.at(-1).content, /call save_newsletter/);

  const n = newsletter.get(issueId);
  assert.equal(n.status, 'ready');
  assert.equal(n.content.sections[0].sources.length, 1, 'non-https links dropped');
  assert.equal(n.usage.web_searches, 9);
  // The reviewer is told, by notification and email.
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE '%newsletter is ready to review'"));
  const mail = db.one("SELECT * FROM outbox WHERE subject LIKE '%newsletter is ready to review' ORDER BY id DESC");
  assert.ok(mail, 'email to the reviewer');
  assert.equal(mail.internal, 1);
  assert.match(mail.body, /Review the newsletter \| http.*#\/newsletters\/\d+/);
  assert.match(mail.body, /Check the Perth figure/);
});

test('each client sees their own rates against the average', () => {
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', issueId);
  const content = JSON.parse(n.content);
  const mia = newsletter.render(n, content, { id: people.mia.id, first_name: 'Mia', owner_id: null });
  assert.match(mia.html, /How does your rate compare\?/);
  assert.match(mia.html, /Westpac · Home loan \(variable\)/);
  assert.match(mia.html, /0\.34% above<\/strong> the average, about <strong>\$1,972 a year<\/strong>/);
  assert.match(mia.html, /ANZ · Investment loan/);
  assert.match(mia.html, /0\.20% below/);
  assert.match(mia.text, /Westpac: your rate 6\.24%, average 5\.90%/);
  assert.match(mia.html, /Home value change, September/);
  assert.match(mia.html, /−?-0\.3%|-0\.3%/);
  const noah = newsletter.render(n, content, { id: people.noah.id, first_name: 'Noah', owner_id: null });
  assert.match(noah.html, /average \(owner-occupier fixed\)/i, 'fixed loan compared with fixed average');
  assert.match(noah.html, /Fixed until 30 June 2027/);
  const nobody = newsletter.render(n, content, null);
  assert.match(nobody.html, /Average home loan rates this month/);
  assert.match(nobody.html, /general information only/);
});

test('booking link, unsubscribe and editing', async () => {
  await api.put('/newsletters/settings', { booking_url: 'https://calendly.com/efh/30min' });
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', issueId);
  let r = newsletter.render(n, JSON.parse(n.content), { id: people.mia.id, first_name: 'Mia' }, { senderId: 1 });
  assert.match(r.html, /href="https:\/\/calendly\.com\/efh\/30min"[^>]*>Book a meeting with me/);
  assert.match(r.html, /href="mailto:[^"]*Unsubscribe/i, 'no public address: unsubscribe by email');

  await api.put('/settings', { app_url: 'https://crm.efh.com.au' });
  r = newsletter.render(n, JSON.parse(n.content), { id: people.mia.id, first_name: 'Mia' });
  const link = /href="(https:\/\/crm\.efh\.com\.au\/api\/public\/unsubscribe\?[^"]+)"/.exec(r.html)[1].replace(/&amp;/g, '&');
  const q = new URL(link).search;
  const page = await fetch(`${srv.base}/public/unsubscribe${q.replace('/api', '')}`);
  assert.match(await page.text(), /unsubscribed/);
  assert.equal(db.one('SELECT marketing_opt_in FROM contacts WHERE id = ?', people.mia.id).marketing_opt_in, 0);
  assert.match(await (await fetch(`${srv.base}/public/unsubscribe?c=${people.noah.id}&t=wrongwrongwrongwrongwron`)).text(), /didn&#39;t work/);
  db.run('UPDATE contacts SET marketing_opt_in = 1 WHERE id = ?', people.mia.id);
  await api.put('/settings', { app_url: '' });

  const edited = { ...JSON.parse(n.content), headline: 'Rates steady, prices rising' };
  assert.equal((await api.put(`/newsletters/${issueId}`, { content: edited })).data.content.headline, 'Rates steady, prices rising');
  assert.equal((await api.put(`/newsletters/${issueId}`, { content: { ...edited, sections: [] } })).status, 400);
  const cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${srv.base}/newsletters/${issueId}/preview?contact_id=${people.mia.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Rates steady, prices rising/);
  assert.match(html, /Hi Mia/);
});

test('test email, then sending to every client', async () => {
  const t = await api.post(`/newsletters/${issueId}/test`);
  assert.equal(t.status, 200);
  assert.equal(t.data.to, 'admin@test.local');
  const sent = (await api.post(`/newsletters/${issueId}/send`, { exclude: [people.noah.id] })).data;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sent_count, 1);
  const rows = db.all('SELECT * FROM outbox WHERE newsletter_id = ?', issueId);
  assert.deepEqual(rows.map((r) => r.to_email), ['mia@example.com']);
  assert.match(rows[0].html_body, /How does your rate compare/);
  assert.equal(rows[0].subject, NEWSLETTER.subject);
  await require('../src/services/mailer').processOutbox();
  assert.ok(['logged', 'sent'].includes(db.one('SELECT status FROM outbox WHERE id = ?', rows[0].id).status));
  assert.equal((await api.post(`/newsletters/${issueId}/send`)).status, 400, 'only once');
  assert.equal((await api.del(`/newsletters/${issueId}`)).status, 400, 'kept as a record');
  const list = (await api.get('/newsletters')).data;
  assert.equal(list.rows[0].status, 'sent');
  assert.equal(list.settings.day, 20);
  const outbox = (await api.get('/outbox')).data.rows.find((m) => m.newsletter_id === issueId);
  assert.equal(outbox.html_body, undefined, 'big HTML not in lists');
});

test('settings validation, and a failed AI run is reported', async () => {
  assert.equal((await api.put('/newsletters/settings', { day: 31 })).status, 400);
  assert.equal((await api.put('/newsletters/settings', { sources: 'afr.com not a site!' })).status, 400);
  const s = (await api.put('/newsletters/settings', { day: 15, sources: 'https://www.afr.com/\nrba.gov.au', audience: ['client', 'past_client'] })).data;
  assert.deepEqual([s.day, s.sources, s.audience], [15, ['afr.com', 'rba.gov.au'], ['client', 'past_client']]);
  await api.put('/ai/config', { api_key: '' });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-badkeybadkeybad';
  const fail = http.createServer((req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
  await new Promise((r) => { fail.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fail.address().port}`;
  const g = newsletter.generate('2027-01');
  await g.done;
  const n = newsletter.get(g.id);
  assert.equal(n.status, 'failed');
  assert.match(n.error, /API key was rejected/);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'The January 2027 newsletter couldn''t be written%'"));
  fail.close();
  delete process.env.ANTHROPIC_API_KEY;
});
