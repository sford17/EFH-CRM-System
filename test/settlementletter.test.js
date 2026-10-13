'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A stand-in for the Claude API that streams back a structured answer.
const requests = [];
let reply = null;
let failWith = null;
const claude = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push({ path: req.url, headers: req.headers, body });
  if (failWith) {
    res.writeHead(failWith, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: failWith === 401 ? 'authentication_error' : 'api_error', message: 'nope' } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const text = JSON.stringify(reply);
  for (let i = 0; i < text.length; i += 40) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 40) } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 300 } });
  send('message_stop', { type: 'message_stop' });
  return res.end();
});

let srv;
let api;
let db;
let deal;
let mia;
before(async () => {
  await new Promise((r) => { claude.listen(0, '127.0.0.1', r); });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${claude.address().port}`;
  delete process.env.ANTHROPIC_API_KEY;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => { srv.close(); claude.close(); });

const { today } = require('../src/util');
const PDF = Buffer.from('%PDF-1.4\n% pretend loan contract\n').toString('base64');

test('setup: a purchase deal for a couple', async () => {
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com' })).data;
  const tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom' }, relationship: 'spouse', shared_finances: 1 })).data;
  deal = (await api.post('/deals', {
    contact_id: mia.id, co_borrower_id: tom.related_id, lender_id: wbc, loan_purpose: 'purchase', loan_amount: 640000, interest_rate: 5.84,
    product_name: 'Flexi First Option', application_ref: 'WBC-123', property_address: '8 King St, Newtown NSW 2042', stage: 'settlement_booked', settlement_date: today(),
  })).data;
});

test('the letter starts from the deal and lists what is still needed', async () => {
  const r = (await api.get(`/deals/${deal.id}/settlement-letter`)).data;
  assert.equal(r.saved, false);
  assert.equal(r.suggested, true);
  assert.equal(r.details.borrowers, 'Mia Jones & Tom Jones');
  assert.equal(r.details.lender_name, 'Westpac');
  assert.deepEqual([r.details.loans[0].loan_amount, r.details.loans[0].interest_rate, r.details.loans[0].account_number], [640000, 5.84, 'WBC-123']);
  assert.deepEqual(r.missing, ['Repayment amount', 'First repayment date', 'Direct debit account']);
  assert.equal(r.ai_configured, false);
  assert.equal(r.email.to, 'mia@example.com');
  assert.match(r.email.subject, /Westpac loan has settled/);
});

test('reading documents needs an API key, set by an admin', async () => {
  const r = await api.post(`/deals/${deal.id}/settlement-letter/read`, { files: [{ name: 'contract.pdf', mime: 'application/pdf', data: PDF }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /isn't set up yet/);
  assert.equal((await api.put('/ai/config', { api_key: 'not-a-key' })).status, 400);
  const ok = (await api.put('/ai/config', { api_key: 'sk-ant-api03-testkey1234567890' })).data;
  assert.equal(ok.configured, true);
  assert.equal(ok.model, 'claude-opus-5-5');
  assert.notEqual(db.getSetting('anthropic_api_key'), 'sk-ant-api03-testkey1234567890', 'stored encrypted');
});

test('AI reads the documents into the letter, flagging what to check', async () => {
  reply = {
    borrowers: 'Mia Jane Jones & Thomas Jones', lender_name: 'Westpac', settlement_date: today(), property_address: '8 King Street, Newtown NSW 2042',
    loans: [
      { account_number: '032-001 123456', product: 'Flexi First Option', loan_amount: 500000, interest_rate: 5.84, rate_type: 'variable', fixed_until: null, loan_term_years: 30, repayment_type: 'pi', io_until: null, repayment_amount: 2946.5, repayment_frequency: 'monthly', first_repayment_date: '2026-11-13', offset_account: '032-001 654321' },
      { account_number: '032-001 777777', product: 'Fixed Option 2 yrs', loan_amount: 140000, interest_rate: 5.49, rate_type: 'fixed', fixed_until: '2028-10-13', loan_term_years: 30, repayment_type: 'pi', io_until: null, repayment_amount: 794.03, repayment_frequency: 'monthly', first_repayment_date: 'soon', offset_account: null },
    ],
    direct_debit: { bank: 'Commonwealth Bank', account_name: 'M J Jones & T Jones', bsb: '06200', account_number: '1234 5678' },
    lender_phone: '132 032', uncertain: ['loans[1].repayment_amount'], notes: ['The offer and the settlement letter show different first repayment dates; I used the settlement letter.'],
  };
  const r = await api.post(`/deals/${deal.id}/settlement-letter/read`, {
    files: [{ name: 'Loan contract.pdf', mime: 'application/pdf', data: PDF }, { name: 'DDR.png', mime: 'image/png', data: 'iVBORw0KGgo=' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = requests.at(-1);
  assert.equal(sent.path, '/v1/messages?beta=true');
  assert.equal(sent.headers['x-api-key'], 'sk-ant-api03-testkey1234567890');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.fallbacks, 'default');
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.thinking, { type: 'adaptive' });
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.deepEqual(sent.body.messages[0].content.map((b) => b.type), ['document', 'image', 'text']);
  assert.equal(sent.body.messages[0].content[0].title, 'Loan contract.pdf');

  const x = r.data.details;
  assert.equal(x.borrowers, 'Mia Jane Jones & Thomas Jones');
  assert.equal(x.loans.length, 2);
  assert.equal(x.loans[0].repayment_amount, 2946.5);
  assert.equal(x.loans[1].rate_type, 'fixed');
  assert.equal(x.loans[1].first_repayment_date, null, 'not a date: left blank');
  assert.equal(x.direct_debit.bsb, null, '5-digit BSB left blank');
  assert.equal(x.direct_debit.account_number, '12345678');
  assert.equal(x.lender_phone, '132 032');
  assert.deepEqual(r.data.ai.uncertain.sort(), ['direct_debit.bsb', 'loans[1].first_repayment_date', 'loans[1].repayment_amount']);
  assert.match(r.data.ai.notes[0], /different first repayment dates/);
  assert.deepEqual(r.data.ai_files, ['Loan contract.pdf', 'DDR.png']);
  assert.deepEqual(r.data.missing, ['First repayment date (split 2)', 'Direct debit account']);
  assert.equal(db.one("SELECT customer_phone FROM lenders WHERE name = 'Westpac'").customer_phone, '132 032', 'remembered for next time');
});

test('AI errors never sign the broker out', async () => {
  failWith = 401;
  const r = await api.post(`/deals/${deal.id}/settlement-letter/read`, { files: [{ name: 'a.pdf', mime: 'application/pdf', data: PDF }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /API key was rejected/);
  failWith = 500;
  const r2 = await api.post(`/deals/${deal.id}/settlement-letter/read`, { files: [{ name: 'a.pdf', mime: 'application/pdf', data: PDF }] });
  assert.equal(r2.status, 502);
  failWith = null;
  assert.match((await api.post(`/deals/${deal.id}/settlement-letter/read`, { files: [{ name: 'a.docx', mime: 'application/msword', data: PDF }] })).data.error, /isn't a PDF, JPG or PNG/);
});

test('editing by hand, preview and PDF', async () => {
  const cur = (await api.get(`/deals/${deal.id}/settlement-letter`)).data.details;
  cur.loans[1].first_repayment_date = '2026-11-13';
  cur.direct_debit.bsb = '062000';
  assert.equal((await api.put(`/deals/${deal.id}/settlement-letter`, { details: { ...cur, settlement_date: '13/10/2026' } })).status, 400);
  assert.equal((await api.put(`/deals/${deal.id}/settlement-letter`, { details: { ...cur, direct_debit: { ...cur.direct_debit, bsb: '12' } } })).status, 400);
  const saved = (await api.put(`/deals/${deal.id}/settlement-letter`, { details: cur })).data;
  assert.deepEqual(saved.missing, []);
  assert.equal(saved.details.direct_debit.bsb, '062-000');
  assert.match(saved.email.body, /First repayment due: 13 November 2026/);
  assert.match(saved.email.body, /account •••• 5678/, 'account number masked by default');

  const cookie = (await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  })).headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(`${srv.base}/deals/${deal.id}/settlement-letter/preview`, { headers: { Cookie: cookie } })).text();
  for (const s of ['Settlement confirmation', 'Mia Jane Jones &amp; Thomas Jones', '$640,000', '5.49% fixed until 13 October 2028', '$2,946.50 per month', '062-000', '•••• 5678', 'Call Westpac on 132 032']) {
    assert.ok(html.includes(s), `preview shows ${s}`);
  }
  const pdf = await fetch(`${srv.base}/deals/${deal.id}/settlement-letter/pdf`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers.get('content-disposition'), /Settlement%20letter/);
});

test('settling the deal adds a task; emailing sends the PDF and closes it', async () => {
  await api.post(`/deals/${deal.id}/stage`, { stage: 'settled' });
  const task = db.one("SELECT * FROM tasks WHERE deal_id = ? AND title LIKE 'Send settlement letter%'", deal.id);
  assert.ok(task, 'task to send it');
  assert.equal(task.status, 'open');
  const letter = (await api.get(`/deals/${deal.id}/settlement-letter`)).data;
  const r = await api.post(`/deals/${deal.id}/settlement-letter/email`, letter.email);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  assert.equal(r.data.sent_to, 'mia@example.com');
  const out = db.one('SELECT * FROM outbox WHERE id = ?', r.data.outbox.id);
  const files = JSON.parse(out.attachments);
  assert.match(files[0].filename, /^Settlement letter – Mia Jane Jones & Thomas Jones\.pdf$/);
  assert.equal(Buffer.from(files[0].data, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(db.one('SELECT status FROM tasks WHERE id = ?', task.id).status, 'done');
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body = 'Settlement letter emailed to mia@example.com'", mia.id));
  assert.equal((await api.post(`/deals/${deal.id}/settlement-letter/email`, { ...letter.email, to: 'nope' })).status, 400);
});

test('auto-send at settlement when the letter is complete', async () => {
  await api.put('/settings', { settlement_letter_auto_send: '1' });
  const wbc = db.one("SELECT id FROM lenders WHERE name = 'Westpac'").id;
  const zoe = (await api.post('/contacts', { first_name: 'Zoe', last_name: 'Clarke', email: 'zoe@example.com' })).data;
  const d2 = (await api.post('/deals', { contact_id: zoe.id, lender_id: wbc, loan_purpose: 'refinance', loan_amount: 400000, interest_rate: 5.6, stage: 'settlement_booked', settlement_date: today() })).data;
  const l = (await api.get(`/deals/${d2.id}/settlement-letter`)).data.details;
  l.loans[0] = { ...l.loans[0], repayment_amount: 2296, first_repayment_date: '2026-11-20' };
  l.direct_debit = { bank: 'ING', account_name: 'Z Clarke', bsb: '923100', account_number: '55551234' };
  await api.put(`/deals/${d2.id}/settlement-letter`, { details: l });
  await api.post(`/deals/${d2.id}/stage`, { stage: 'settled' });
  await new Promise((r) => { setTimeout(r, 300); });
  const after = (await api.get(`/deals/${d2.id}/settlement-letter`)).data;
  assert.equal(after.status, 'sent');
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body = 'Settlement letter sent automatically to zoe@example.com'", zoe.id));
  assert.equal(db.one("SELECT COUNT(*) AS n FROM tasks WHERE deal_id = ? AND title LIKE 'Send settlement letter%'", d2.id).n, 0);
  await api.put('/settings', { settlement_letter_auto_send: '0' });
});
