'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const LEADS = {
  leads: [
    {
      name: 'Sarah Nguyen', organisation: 'Harbour Realty Parramatta', role: 'Sales agent', category: 'real_estate', suburb: 'Parramatta', state: 'NSW',
      website: 'https://harbourrealty.example.com.au', email: 'Sarah@HarbourRealty.example.com.au', phone: '02 9000 1234',
      source_url: 'https://harbourrealty.example.com.au/team/sarah', source_title: 'Sarah Nguyen – Harbour Realty',
      relevance: 'Lists 35 first-home sales in Parramatta this year.', outreach_tip: 'Call about co-hosting a first home buyer evening.',
    },
    { // the same person again
      name: 'Sarah Nguyen', organisation: 'Harbour Realty Parramatta', role: null, category: 'real_estate', suburb: null, state: 'NSW',
      website: null, email: 'sarah@harbourrealty.example.com.au', phone: null, source_url: 'https://www.realestate.example.com.au/agent/sarah', source_title: 'Profile', relevance: 'x', outreach_tip: 'y',
    },
    {
      name: 'Westside Accounting', organisation: 'Westside Accounting', role: null, category: 'accountant', suburb: 'Penrith', state: 'NSW',
      website: 'westsideaccounting.example.com.au', email: 'not-an-email', phone: '123', source_url: 'https://westsideaccounting.example.com.au', source_title: 'Westside Accounting',
      relevance: 'Small-business tax specialists; clients often need commercial loans.', outreach_tip: 'Offer a lending update for their clients.',
    },
    { name: 'No Source Pty Ltd', organisation: null, role: null, category: 'business', suburb: null, state: null, website: null, email: null, phone: null, source_url: 'javascript:alert(1)', source_title: '', relevance: '', outreach_tip: '' },
    {
      name: 'Existing Partner', organisation: 'Known Co', role: null, category: 'solicitor', suburb: null, state: 'NSW', website: null,
      email: 'existing@known.example.com', phone: null, source_url: 'https://known.example.com', source_title: 'Known', relevance: 'Known', outreach_tip: '-',
    },
  ],
  search_notes: ['Searched realestate.com.au agent profiles and accountant directories.'],
};

const requests = [];
let failWith = null;
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  if (failWith) {
    res.writeHead(failWith, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 1, server_tool_use: { web_search_requests: 6 } } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'save_leads', input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(LEADS) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 800 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

let srv;
let api;
let db;
let leads;
let searchId;
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  leads = require('../src/services/leadGenerator');
});
after(() => { srv.close(); claude.close(); });

test('needs an API key and a request', async () => {
  assert.match((await api.post('/leads/searches', { request: 'Real estate agents in Parramatta' })).data.error, /needs an Anthropic API key/);
  await api.put('/ai/config', { api_key: 'sk-ant-api03-leadstest1234567' });
  assert.equal((await api.post('/leads/searches', { request: 'hi' })).status, 400);
  await api.post('/partners', { name: 'Existing Partner', company: 'Known Co', type: 'solicitor', email: 'existing@known.example.com' });
});

test('a search runs in the background, then lists cleaned-up leads', async () => {
  const r = await api.post('/leads/searches', { request: 'Real estate agents who sell lots of first homes', location: 'Parramatta NSW', lead_type: 'referral_partner', max_results: 50 });
  assert.equal(r.status, 202);
  assert.equal(r.data.status, 'searching');
  assert.equal(r.data.max_results, 30, 'capped');
  searchId = r.data.id;
  assert.equal((await api.post('/leads/searches', { request: 'Accountants in Penrith' })).status, 400, 'one search at a time');
  for (let i = 0; i < 50 && (await api.get(`/leads/searches/${searchId}`)).data.status === 'searching'; i += 1) await new Promise((x) => { setTimeout(x, 50); });

  const sent = requests[0];
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.ok(sent.tools.some((t) => t.type === 'web_search_20260209'));
  assert.equal(sent.tools.find((t) => t.name === 'save_leads').strict, true);
  assert.match(sent.system, /Never collect personal mobile numbers/);
  assert.match(sent.system, /in or near Parramatta NSW/);
  assert.match(sent.messages[0].content, /Type: Referral partners/);

  const s = (await api.get(`/leads/searches/${searchId}`)).data;
  assert.equal(s.status, 'ready');
  assert.deepEqual(s.leads.map((l) => l.name), ['Sarah Nguyen', 'Westside Accounting', 'Existing Partner'], 'duplicates and sourceless leads dropped');
  const sarah = s.leads[0];
  assert.equal(sarah.email, 'sarah@harbourrealty.example.com.au');
  assert.equal(sarah.category_label, 'Real estate agent');
  const acct = s.leads[1];
  assert.deepEqual([acct.email, acct.phone, acct.website], [null, null, 'https://westsideaccounting.example.com.au/'], 'bad details blanked');
  assert.equal(s.leads[2].existing.kind, 'partner', 'already in the CRM');
  assert.deepEqual(s.notes, ['Searched realestate.com.au agent profiles and accountant directories.']);
  assert.equal(s.usage.web_searches, 6);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'Lead search finished: 3 leads%'"));
});

test('adding leads: as a contact without marketing consent, or as a partner', async () => {
  const s = (await api.get(`/leads/searches/${searchId}`)).data;
  const asLead = (await api.post(`/leads/searches/${searchId}/leads/${s.leads[0].id}/add`, { as: 'lead' })).data;
  const c = db.one('SELECT * FROM contacts WHERE id = ?', asLead.id);
  assert.deepEqual([c.first_name, c.last_name, c.status, c.lead_source, c.marketing_opt_in, c.employer], ['Sarah', 'Nguyen', 'lead', 'lead_generator', 0, 'Harbour Realty Parramatta']);
  assert.match(c.background, /Why: Lists 35 first-home sales/);
  assert.match(c.background, /Source: https:\/\/harbourrealty/);
  assert.equal((await api.post(`/leads/searches/${searchId}/leads/${s.leads[0].id}/add`, { as: 'lead' })).status, 400, 'only once');

  const asPartner = (await api.post(`/leads/searches/${searchId}/leads/${s.leads[1].id}/add`, { as: 'partner' })).data;
  const p = db.one('SELECT * FROM referral_partners WHERE id = ?', asPartner.id);
  assert.deepEqual([p.name, p.type], ['Westside Accounting', 'accountant']);
  assert.match(p.notes, /Website: https:\/\/westsideaccounting/);

  await api.post(`/leads/searches/${searchId}/leads/${s.leads[2].id}/dismiss`);
  const after = (await api.get(`/leads/searches/${searchId}`)).data;
  assert.deepEqual(after.leads.map((l) => l.status), ['added', 'added', 'dismissed']);
  const list = (await api.get('/leads/searches')).data.rows;
  assert.deepEqual([list[0].count, list[0].added], [3, 2]);
  assert.equal((await api.post(`/leads/searches/${searchId}/leads/1/add`, { as: 'friend' })).status, 400);
});

test('failures are recorded; searches are private', async () => {
  failWith = 429;
  const { id, done } = leads.start(1, { request: 'Builders doing house and land packages in Western Sydney' });
  await done;
  const s = leads.get(id, 1);
  assert.equal(s.status, 'failed');
  assert.match(s.error, /busy/);
  failWith = null;
  const other = db.insert('users', { name: 'Jo', email: 'jo2@test.local', password_hash: 'x', role: 'broker' });
  assert.throws(() => leads.get(id, other), /not found/);
  assert.equal((await api.del(`/leads/searches/${id}`)).data.ok, true);
});
