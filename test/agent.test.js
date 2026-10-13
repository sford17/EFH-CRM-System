'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A scripted Claude: each request gets the next scripted reply.
const requests = [];
const script = [];
let failWith = null;
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  if (failWith) {
    res.writeHead(failWith, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  }
  const reply = script.shift() || { blocks: [{ type: 'text', text: 'OK.' }], stop: 'end_turn' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 1, cache_read_input_tokens: 1500 } } });
  reply.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,12}/gs)) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop, stop_sequence: null }, usage: { output_tokens: 120 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
});

let srv;
let db;
let cookie;
let mia;
const T = require('../src/util').today();
const addDays = require('../src/util').addDays;

before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  const api = srv.client();
  await api.login();
  cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
});
after(() => { srv.close(); claude.close(); });

const call = async (method, path, body) => {
  const res = await fetch(`${srv.base}${path}`, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  if (type.includes('event-stream')) {
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    return { status: res.status, events, done: events.find((e) => e.type === 'done')?.conversation };
  }
  return { status: res.status, data: await res.json() };
};

let convId;

test('setup: a client with a fixed rate ending soon, and an API key', async () => {
  mia = (await call('POST', '/contacts', { first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com', mobile: '0412 345 678' })).data;
  await call('POST', '/tracker/loans', { contact_id: mia.id, lender_name: 'Westpac', loan_type: 'home_loan', limit_amount: 600000, balance: 580000, interest_rate: 5.69, rate_type: 'fixed', fixed_expiry_date: addDays(T, 40) });
  const r = await call('POST', '/agent/conversations', {});
  convId = r.data.id;
  const noKey = await call('POST', `/agent/conversations/${convId}/messages`, { text: 'hi' });
  assert.equal(noKey.status, 400);
  assert.match(noKey.data.error, /needs an Anthropic API key/);
  await call('PUT', '/ai/config', { api_key: 'sk-ant-api03-agenttest123456' });
});

test('a question: it looks things up, then answers with links (streamed)', async () => {
  script.push(
    { blocks: [{ type: 'tool_use', id: 'tu_1', name: 'find_loans', input: { fixed_expiring_within_days: 90, io_expiring_within_days: null, rate_above: null, lender: null, limit: null } }], stop: 'tool_use' },
    { blocks: [{ type: 'text', text: `One client: [Mia Jones](#/contacts/${0}) – Westpac fixed at 5.69% ends soon.` }], stop: 'end_turn' },
  );
  const r = await call('POST', `/agent/conversations/${convId}/messages`, { text: 'Which clients have fixed rates ending in the next 90 days?' });
  assert.equal(r.status, 200);
  assert.ok(r.events.some((e) => e.type === 'lookup' && e.label === 'Searching the mortgage tracker'));
  assert.ok(r.events.filter((e) => e.type === 'text').length > 2, 'text streamed in pieces');
  const first = requests.at(-2);
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.ok(first.tools.some((t) => t.name === 'send_email' && t.strict === true && t.eager_input_streaming === true));
  assert.ok(first.tools.some((t) => t.type === 'web_search_20260209'));
  assert.match(first.system, /Approve button/);
  const toolResult = requests.at(-1).messages.at(-1).content[0];
  assert.equal(toolResult.tool_use_id, 'tu_1');
  const found = JSON.parse(toolResult.content);
  assert.equal(found.count, 1);
  assert.equal(found.loans[0].client, 'Mia Jones');
  assert.equal(found.loans[0].link, `#/contacts/${mia.id}?tab=tracker`);
  const items = r.done.items;
  assert.deepEqual(items.map((i) => i.type), ['user', 'lookup', 'assistant']);
  assert.equal(r.done.title, 'Which clients have fixed rates ending in the next 90 days?');
  assert.ok(r.done.usage.cache_read_input_tokens >= 3000);
});

test('a task: the action waits for approval, then runs', async () => {
  script.push(
    { blocks: [{ type: 'text', text: 'I\'ll set that up.' }, { type: 'tool_use', id: 'tu_2', name: 'create_task', input: { title: 'Call Mia about her fixed rate', description: null, due_date: addDays(T, 2), priority: 'high', contact_id: mia.id, deal_id: null, assign_to_user_id: null } }], stop: 'tool_use' },
  );
  const r = await call('POST', `/agent/conversations/${convId}/messages`, { text: 'Create a task for me to call her this week' });
  const approval = r.events.find((e) => e.type === 'approval');
  assert.ok(approval);
  assert.match(approval.actions[0].summary, /^Create a task: "Call Mia about her fixed rate", due .*, about Mia Jones$/);
  assert.equal(r.done.waiting, true);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Call Mia about her fixed rate'").n, 0, 'nothing done yet');
  assert.equal((await call('POST', `/agent/conversations/${convId}/messages`, { text: 'and another thing' })).status, 400, 'decide first');

  script.push({ blocks: [{ type: 'text', text: 'Done – the task is on your list.' }], stop: 'end_turn' });
  const d = await call('POST', `/agent/conversations/${convId}/decide`, { decisions: { tu_2: 'approve' } });
  assert.equal(d.status, 200);
  const task = db.one("SELECT * FROM tasks WHERE title = 'Call Mia about her fixed rate'");
  assert.ok(task);
  assert.deepEqual([task.priority, task.contact_id, task.assigned_to], ['high', mia.id, 1]);
  const sentBack = requests.at(-1).messages.at(-1).content[0];
  assert.equal(sentBack.tool_use_id, 'tu_2');
  assert.equal(JSON.parse(sentBack.content).done, true);
  const action = d.done.items.find((i) => i.type === 'action');
  assert.equal(action.outcome, 'done');
  assert.equal(d.done.waiting, false);
});

test('an email can be edited before it\'s approved; another action declined', async () => {
  script.push({
    blocks: [
      { type: 'tool_use', id: 'tu_3', name: 'send_email', input: { contact_id: mia.id, deal_id: null, subject: 'Your fixed rate', body: 'Hi Mia,\n\nYour fixed rate ends soon.' } },
      { type: 'tool_use', id: 'tu_4', name: 'send_sms', input: { contact_id: mia.id, deal_id: null, message: 'Hi Mia, check your email!' } },
    ],
    stop: 'tool_use',
  });
  const r = await call('POST', `/agent/conversations/${convId}/messages`, { text: 'Email and text her about it' });
  const approval = r.events.find((e) => e.type === 'approval');
  assert.equal(approval.actions.length, 2);
  assert.match(approval.actions[0].summary, /Email Mia Jones <mia@example.com>: "Your fixed rate"/);
  assert.equal(approval.actions[0].preview, 'Hi Mia,\n\nYour fixed rate ends soon.');

  script.push({ blocks: [{ type: 'text', text: 'Emailed; I didn\'t send the text.' }], stop: 'end_turn' });
  const d = await call('POST', `/agent/conversations/${convId}/decide`, {
    decisions: { tu_3: 'approve', tu_4: 'decline' }, edits: { tu_3: { body: 'Hi Mia,\n\nYour fixed rate with Westpac ends next month. Shall we review it?' } },
  });
  const mail = db.one("SELECT * FROM outbox WHERE subject = 'Your fixed rate'");
  assert.match(mail.body, /Shall we review it\?/, 'the edited wording was sent');
  assert.equal(db.one("SELECT COUNT(*) AS n FROM sms_messages WHERE body LIKE 'Hi Mia, check%'").n, 0, 'declined text not sent');
  const results = requests.at(-1).messages.at(-1).content;
  assert.deepEqual(results.map((x) => x.tool_use_id), ['tu_3', 'tu_4'], 'all results together, in order');
  assert.match(results[0].content, /edited the wording/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /declined/);
  const actions = d.done.items.filter((i) => i.type === 'action').slice(-2);
  assert.deepEqual(actions.map((a) => a.outcome), ['done', 'declined']);
});

test('bad tool input is sent back to the model, not run', async () => {
  script.push(
    { blocks: [{ type: 'tool_use', id: 'tu_5', name: 'get_contact', input: { contact_id: 'Mia' } }], stop: 'tool_use' },
    { blocks: [{ type: 'text', text: 'Let me try again.' }], stop: 'end_turn' },
  );
  await call('POST', `/agent/conversations/${convId}/messages`, { text: 'Tell me about Mia' });
  const res = requests.at(-1).messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /INVALID_JSON.*contact_id should be a whole number/);
});

test('API errors come back in the stream, and conversations are private', async () => {
  failWith = 401;
  const r = await call('POST', `/agent/conversations/${convId}/messages`, { text: 'Anything?' });
  assert.equal(r.status, 200);
  assert.match(r.events.find((e) => e.type === 'error').message, /API key was rejected/);
  failWith = null;
  const list = (await call('GET', '/agent/conversations')).data;
  assert.equal(list.rows[0].id, convId);
  const other = db.insert('users', { name: 'Jo', email: 'jo@test.local', password_hash: 'x', role: 'broker' });
  const theirs = db.insert('ai_conversations', { user_id: other });
  assert.equal((await call('GET', `/agent/conversations/${theirs}`)).status, 404);
  assert.equal((await call('DELETE', `/agent/conversations/${convId}`)).data.ok, true);
});
