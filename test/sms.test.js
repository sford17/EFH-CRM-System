'use strict';
// SMS via a fake ClickSend API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const sent = [];
let reject = null;
const clicksend = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const json = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.headers.authorization !== `Basic ${Buffer.from('efh:key-123').toString('base64')}`) {
    return json(401, { http_code: 401, response_code: 'UNAUTHORIZED', response_msg: 'Invalid credentials' });
  }
  const msg = JSON.parse(raw).messages[0];
  if (reject) { const status = reject; reject = null; return json(200, { http_code: 200, response_code: 'SUCCESS', data: { messages: [{ status }] } }); }
  sent.push(msg);
  json(200, { http_code: 200, response_code: 'SUCCESS', data: { messages: [{ status: 'SUCCESS', message_id: `cs-${sent.length}` }] } });
});

let srv;
let api;
let db;
const tick = () => new Promise((r) => setTimeout(r, 150));

before(async () => {
  await new Promise((r) => clicksend.listen(0, '127.0.0.1', r));
  process.env.CLICKSEND_API_URL = `http://127.0.0.1:${clicksend.address().port}/v3`;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(async () => { await srv.close(); clicksend.close(); });

test('mobile number formats', () => {
  const { normaliseMobile, normaliseSender, segments } = require('../src/services/sms');
  assert.equal(normaliseMobile('0412 345 678'), '+61412345678');
  assert.equal(normaliseMobile('(04) 1234-5678'), '+61412345678');
  assert.equal(normaliseMobile('61412345678'), '+61412345678');
  assert.equal(normaliseMobile('+64211234567'), '+64211234567');
  assert.equal(normaliseMobile('02 9999 9999'), null);
  assert.equal(normaliseSender('EFH Finance'), 'EFH Finance');
  assert.equal(normaliseSender('Way too long name'), undefined);
  assert.equal(segments('a'.repeat(160)), 1);
  assert.equal(segments('a'.repeat(161)), 2);
  assert.equal(segments('😀'), 1);
  assert.equal(segments('😀'.repeat(40)), 2);
});

test('without ClickSend, texts are logged not sent', async () => {
  const c = (await api.post('/contacts', { first_name: 'Log', mobile: '0400 000 001', status: 'prospect' })).data;
  const r = await api.post('/sms', { contact_id: c.id, body: 'hello' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'logged');
  assert.equal(sent.length, 0);
});

test('admin config and per-user sender number', async () => {
  assert.equal((await api.put('/sms/config', { default_from: 'This is too long' })).status, 400);
  await api.put('/sms/config', { username: 'efh', api_key: 'key-123', default_from: 'EFH Finance' });
  assert.ok(db.getSetting('clicksend_api_key').startsWith('v1:'), 'API key encrypted');
  assert.equal((await api.put('/sms/me', { sms_from: 'not a phone' })).status, 400);
  assert.equal((await api.put('/sms/me', { sms_from: '0411 222 333' })).data.sms_from, '+61411222333');
  const status = (await api.get('/sms/status')).data;
  assert.equal(status.configured, true);
  assert.equal(status.my_from, '+61411222333');
  const t = (await api.post('/sms/test')).data;
  assert.equal(t.status, 'sent');
  assert.equal(sent.at(-1).to, '+61411222333');
});

test('deal stage changes text the borrower from the broker\'s own mobile', async () => {
  const lender = db.one("SELECT id FROM lenders WHERE name = 'ANZ'");
  const c = (await api.post('/contacts', { first_name: 'Mia', email: 'mia@x.example', mobile: '0455 555 555', status: 'prospect' })).data;
  const before = sent.length;
  const deal = (await api.post('/deals', { contact_id: c.id, loan_amount: 500000, lender_id: lender.id, settlement_date: '2026-11-20' })).data;
  await tick();
  assert.match(sent.at(-1).body, /^Hi Mia, thanks for choosing EFH Mortgage Broking for your home loan\. .* - Admin, EFH Mortgage Broking$/);
  assert.equal(sent.at(-1).from, '+61411222333');
  assert.equal(sent.at(-1).to, '+61455555555');

  for (const stage of ['fact_find', 'pre_approval', 'application_lodged', 'conditional_approval', 'unconditional_approval', 'settlement_booked', 'settled']) {
    await api.post(`/deals/${deal.id}/stage`, { stage, settlement_date: '2026-11-20' });
  }
  await tick();
  const texts = sent.slice(before).map((m) => m.body);
  assert.equal(texts.length, 8, texts.join('\n'));
  assert.ok(texts.some((t) => /pre-approved with ANZ/.test(t)));
  assert.ok(texts.some((t) => /settlement is booked for 20 November 2026/.test(t)));
  assert.ok(texts.some((t) => /your loan has settled/.test(t)));
  assert.ok(texts.every((t) => !/STOP/.test(t)), 'service updates carry no opt-out line');

  const detail = (await api.get(`/contacts/${c.id}`)).data;
  assert.equal(detail.sms.filter((s) => s.status === 'sent').length, 8);
  assert.ok(detail.activities.some((a) => a.type === 'sms' && /SMS sent from \+61411222333/.test(a.body)));
});

test('birthday texts are marketing: consent required and opt-out added', async () => {
  const today = require('../src/util').today();
  const yes = (await api.post('/contacts', { first_name: 'Bday', mobile: '0411 000 111', status: 'client', dob: `1980-${today.slice(5)}` })).data;
  const no = (await api.post('/contacts', { first_name: 'NoMkt', mobile: '0411 000 222', status: 'client', dob: `1981-${today.slice(5)}`, marketing_opt_in: 0 })).data;
  const optedOut = (await api.post('/contacts', { first_name: 'NoSms', mobile: '0411 000 333', status: 'client', dob: `1982-${today.slice(5)}`, sms_opt_out: 1 })).data;
  await api.post('/automations/run-scheduled');
  await tick();
  const bday = sent.find((m) => m.to === '+61411000111');
  assert.match(bday.body, /^Happy birthday Bday!.* Reply STOP to opt out\.$/);
  assert.ok(!sent.some((m) => m.to === '+61411000222'));
  assert.ok(!sent.some((m) => m.to === '+61411000333'));
  const run = db.one("SELECT detail FROM automation_runs WHERE entity_id = ? AND entity_type = 'contact' ORDER BY id DESC", no.id);
  assert.match(run.detail, /SMS skipped: Contact has opted out of marketing/);
  assert.ok(yes && optedOut);
});

test('annual review and rate reduction emails also send their SMS', async () => {
  const c = (await api.post('/contacts', { first_name: 'Rev', email: 'rev@x.example', mobile: '0466 000 000', status: 'client' })).data;
  for (const name of ['Annual loan review', 'Rate reduction']) {
    const t = db.one('SELECT id, sms_body FROM email_templates WHERE name = ?', name);
    assert.ok(t.sms_body, `${name} has an SMS`);
    const preview = (await api.post(`/templates/${t.id}/preview`, { contact_id: c.id })).data;
    assert.match(preview.sms, /^Hi Rev,/);
    assert.equal((await api.post(`/templates/${t.id}/send`, { contact_id: c.id })).status, 201);
  }
  await tick();
  const texts = sent.filter((m) => m.to === '+61466000000').map((m) => m.body);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /annual home loan review.*Reply STOP to opt out\.$/);
  assert.match(texts[1], /rates have dropped.*Reply STOP to opt out\.$/);
  // Other templates don't text.
  const welcome = db.one("SELECT id FROM email_templates WHERE name = 'Welcome – new enquiry'");
  await api.post(`/templates/${welcome.id}/send`, { contact_id: c.id });
  await tick();
  assert.equal(sent.filter((m) => m.to === '+61466000000').length, 2);
});

test('rejected texts are marked failed and can be retried', async () => {
  const c = (await api.post('/contacts', { first_name: 'Bad', mobile: '0477 000 000', status: 'prospect' })).data;
  reject = 'INVALID_RECIPIENT';
  const r = (await api.post('/sms', { contact_id: c.id, body: 'hi' })).data;
  assert.equal(r.status, 'failed');
  assert.match(r.error, /invalid recipient/);
  assert.equal((await api.post(`/sms/${r.id}/retry`)).data.status, 'sent');
  assert.equal((await api.post('/sms', { contact_id: c.id, body: '   ' })).status, 400);
  const none = (await api.post('/contacts', { first_name: 'NoMobile', status: 'prospect' })).data;
  assert.match((await api.post('/sms', { contact_id: none.id, body: 'x' })).data.error, /no mobile/);
});

test('upgrading an existing install adds SMS to the default automations', () => {
  const { STAGE_SMS } = require('../src/db/sms-defaults');
  // Rewind to how a version-1 database looked.
  for (const a of db.all('SELECT id, actions FROM automations')) {
    db.update('automations', a.id, { actions: JSON.stringify(JSON.parse(a.actions).filter((x) => x.type !== 'send_sms')) });
  }
  db.run("DELETE FROM automations WHERE name IN ('New deal: welcome SMS', 'Settlement booked: SMS')");
  db.run("DELETE FROM email_templates WHERE name = 'Rate reduction'");
  db.run('UPDATE email_templates SET sms_body = NULL');
  db.get().exec(`DROP TABLE sms_messages; ALTER TABLE contacts DROP COLUMN sms_opt_out; ALTER TABLE users DROP COLUMN sms_from;
    ALTER TABLE email_templates DROP COLUMN sms_body; PRAGMA user_version = 1;`);
  db.migrate();
  assert.equal(db.one('PRAGMA user_version').user_version, 2);
  const withSms = db.all("SELECT name FROM automations WHERE actions LIKE '%send_sms%'").map((r) => r.name);
  for (const name of Object.keys(STAGE_SMS)) assert.ok(withSms.includes(name), name);
  assert.ok(withSms.includes('Client birthday'));
  assert.ok(withSms.includes('New deal: welcome SMS'));
  assert.ok(db.one("SELECT sms_body FROM email_templates WHERE name = 'Rate reduction'").sms_body);
  assert.ok(db.one("SELECT sms_body FROM email_templates WHERE name = 'Annual loan review'").sms_body);
});
