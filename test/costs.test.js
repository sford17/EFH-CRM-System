'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Stand-ins for Claude (returns usage with cache and web searches) and ClickSend (returns prices).
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Answered by a different model than requested (server-side fallback).
  send('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model === 'fallback-test' ? 'claude-sonnet-5-5' : body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100000, cache_creation_input_tokens: 20000, cache_read_input_tokens: 50000, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10000, server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 } } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});
let priced = true;
const clicksend = http.createServer(async (req, res) => {
  for await (const c of req); // eslint-disable-line no-unused-vars
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const m = { status: 'SUCCESS', message_id: `cs-${Date.now()}`, ...(priced ? { message_parts: 2, message_price: '0.1540' } : {}) };
  res.end(JSON.stringify({ http_code: 200, response_code: 'SUCCESS', data: { messages: [m], currency: { currency_name_short: 'AUD' } } }));
});

let srv;
let api;
let db;
let costs;
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  await new Promise((r) => { clicksend.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  process.env.CLICKSEND_API_URL = `http://127.0.0.1:${clicksend.address().port}/v3`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  costs = require('../src/services/costs');
});
after(() => { srv.close(); claude.close(); clicksend.close(); });

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
const month = new Date().toISOString().slice(0, 7);

test('prices: the right model, cache rates, web searches and Haiku\'s long-prompt tier', () => {
  assert.deepEqual(costs.priceFor('claude-opus-5-5'), [4, 5, 8, 0.2, 20]);
  assert.deepEqual(costs.priceFor('claude-opus-5'), [5, 6.25, 10, 0.5, 25], 'not confused with 5.5');
  assert.deepEqual(costs.priceFor('claude-sonnet-4-6-20260101'), [3, 3.75, 6, 0.3, 15]);
  assert.deepEqual(costs.priceFor('claude-haiku-5-5', 150000), [0.5, 0.625, 1, 0.05, 2.5]);
  assert.equal(costs.priceFor('gpt-4'), null);
  // 1M in, 200k 5-min writes, 100k 1-hour writes, 500k reads, 100k out, 4 searches on Opus 5.5.
  near(costs.costOf('claude-opus-5-5', {
    input_tokens: 1e6, cache_creation_input_tokens: 300000, cache_creation: { ephemeral_1h_input_tokens: 100000 }, cache_read_input_tokens: 500000, output_tokens: 100000,
    server_tool_use: { web_search_requests: 4 },
  }), 4 + 1 + 0.8 + 0.1 + 2 + 0.04);
});

test('every Claude request is recorded, priced by the model that answered', async () => {
  await api.put('/ai/config', { api_key: 'sk-ant-api03-coststest1234567' });
  const ai = require('../src/services/loanDocsAI');
  const user = db.one('SELECT id FROM users LIMIT 1');
  await ai.clientFor('assistant', { userId: user.id }).beta.messages.stream({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
  await ai.clientFor('newsletter').beta.messages.stream({ model: 'fallback-test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }).finalMessage();
  const rows = db.all('SELECT * FROM ai_usage ORDER BY id');
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].feature, rows[0].model, rows[0].user_id, rows[0].input_tokens, rows[0].cache_write_tokens, rows[0].cache_read_tokens, rows[0].output_tokens, rows[0].web_searches, rows[0].web_fetches],
    ['assistant', 'claude-opus-5-5', user.id, 100000, 20000, 50000, 10000, 3, 2]);
  // Opus 5.5: 0.1M×4 + 0.02M×5 + 0.05M×0.2 + 0.01M×20 + 3 searches
  near(rows[0].cost_usd, 0.4 + 0.1 + 0.01 + 0.2 + 0.03);
  assert.equal(rows[1].model, 'claude-sonnet-5-5');
  near(rows[1].cost_usd, 0.2 + 0.05 + 0.005 + 0.1 + 0.03);
});

test('texts record what ClickSend charged; others are estimated', async () => {
  await api.put('/sms/config', { username: 'efh', api_key: 'key-123', default_from: 'EFH' });
  const c = (await api.post('/contacts', { first_name: 'Sam', mobile: '0412 345 678' })).data;
  const sms = require('../src/services/sms');
  sms.queueForContact({ contactId: c.id, body: 'Hello! '.repeat(30) });
  await sms.processSms();
  priced = false;
  sms.queueForContact({ contactId: c.id, body: 'Short one' });
  await sms.processSms();
  sms.queueForContact({ contactId: c.id, body: 'Never sent' });
  const rows = db.all('SELECT status, parts, price, currency FROM sms_messages ORDER BY id');
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.status, r.parts, r.price, r.currency]), [['sent', 2, 0.154, 'AUD'], ['sent', 1, null, 'AUD']]);
});

test('the report: by month, running totals, by feature and by sender', async () => {
  let r = (await api.get('/reports/costs?period=cy')).data;
  const m = r.months.find((x) => x.month === month);
  assert.equal(m.ai_usd, 1.13, '0.74 + 0.385, rounded');
  assert.equal(m.ai_aud, null, 'no exchange rate yet');
  assert.deepEqual([m.sms_count, m.sms_parts, m.sms_aud, m.sms_unpriced], [2, 3, 0.15, 1]);
  assert.equal(r.notes.sms_unpriced, 1);
  assert.equal(r.totals.month_total_aud, null);
  assert.equal(r.totals.all_ai_usd, 1.13);
  assert.deepEqual(r.by_feature.map((f) => [f.key, f.requests, f.searches]), [['assistant', 1, 3], ['newsletter', 1, 3]]);
  assert.equal(r.sms_by_sender.length, 1);

  assert.equal((await api.put('/reports/costs/settings', { usd_to_aud: 'abc' })).status, 400);
  assert.equal((await api.put('/reports/costs/settings', { sms_price_per_part: 9 })).status, 400);
  await api.put('/reports/costs/settings', { usd_to_aud: 1.5, sms_price_per_part: 0.08 });
  r = (await api.get('/reports/costs?period=cy')).data;
  const m2 = r.months.find((x) => x.month === month);
  assert.equal(m2.ai_aud, 1.69);
  assert.equal(m2.sms_aud, 0.23, '0.154 reported + 1 part × 0.08 estimated');
  assert.equal(m2.sms_unpriced, 0);
  assert.equal(m2.total_aud, 1.92);
  assert.equal(r.months.at(-1).running_aud, 1.92, 'running total carries through the year');
  assert.equal(r.totals.all_total_aud, 1.92);
  assert.equal(r.by_feature[0].aud, 1.11);
  // A month with nothing still shows the running total so far.
  const later = r.months.filter((x) => x.month > month);
  if (later.length) assert.equal(later[0].running_aud, 1.92);
});

test('usage saved before the report existed is added as an estimate', () => {
  const user = db.one('SELECT id FROM users LIMIT 1');
  db.insert('lead_searches', { user_id: user.id, request: 'Agents in Ryde', status: 'ready', usage: JSON.stringify({ input_tokens: 200000, output_tokens: 5000, web_searches: 10 }), model: 'claude-opus-5-5' });
  const before = db.one('SELECT COUNT(*) AS n FROM ai_usage').n;
  costs.backfill(db);
  const row = db.one("SELECT * FROM ai_usage WHERE feature = 'lead_generator'");
  assert.equal(db.one('SELECT COUNT(*) AS n FROM ai_usage').n, before + 1);
  assert.equal(row.estimated, 1);
  near(row.cost_usd, 0.8 + 0.1 + 0.1);
});

test('only admins change the cost settings', async () => {
  await api.post('/users', { name: 'Bea Broker', email: 'bea@test.local', password: 'password123', role: 'broker' });
  const broker = srv.client();
  await broker.login('bea@test.local', 'password123');
  assert.equal((await broker.put('/reports/costs/settings', { usd_to_aud: 2 })).status, 403);
  assert.equal((await broker.get('/reports/costs?period=fy')).status, 200);
});
