'use strict';
// Exercises the Adobe Acrobat Sign integration against a fake Adobe server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const KEY = 'test-integration-key-1234567890';
const fake = { uploads: [], agreements: new Map(), reminders: [], cancels: [], users: [], next: 1 };
let base;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { code: 'INVALID_ACCESS_TOKEN', message: 'Access token provided is invalid or has expired' });
  fake.users.push(req.headers['x-api-user'] || null);
  const p = url.pathname.replace('/api/rest/v6', '');
  if (p === '/baseUris') return json(200, { apiAccessPoint: `${base}/`, webAccessPoint: `${base}/` });
  if (p === '/users/me') return json(200, { email: 'sam@efh.example', firstName: 'Sam', lastName: 'Ford' });
  if (p === '/transientDocuments' && req.method === 'POST') {
    if (!/^multipart\/form-data/.test(req.headers['content-type'])) return json(400, { code: 'BAD_REQUEST', message: 'multipart expected' });
    const text = raw.toString('latin1');
    fake.uploads.push({ fileName: /name="File-Name"\r\n\r\n([^\r]*)/.exec(text)?.[1], hasPdf: text.includes('%PDF-') });
    return json(201, { transientDocumentId: `tdoc-${fake.uploads.length}` });
  }
  if (p === '/agreements' && req.method === 'POST') {
    const body = JSON.parse(raw.toString());
    if (body.name === 'Make Adobe fail') return json(400, { code: 'INVALID_PARTICIPANT', message: 'One of the participants is invalid' });
    const id = `agr-${fake.next++}`;
    fake.agreements.set(id, { body, status: 'OUT_FOR_SIGNATURE', signed: new Set(), declined: null });
    return json(201, { id });
  }
  const m = p.match(/^\/agreements\/([^/]+)(\/.*)?$/);
  const a = m && fake.agreements.get(decodeURIComponent(m[1]));
  if (!a) return json(404, { code: 'INVALID_AGREEMENT_ID', message: 'not found' });
  const sets = () => a.body.participantSetsInfo.map((s, i) => {
    const email = s.memberInfos[0].email;
    const minOrder = Math.min(...a.body.participantSetsInfo.filter((x) => !a.signed.has(x.memberInfos[0].email)).map((x) => x.order));
    const status = a.signed.has(email) ? 'COMPLETED' : a.declined === email ? 'DECLINED'
      : a.status !== 'OUT_FOR_SIGNATURE' ? a.status : s.order === minOrder ? 'WAITING_FOR_MY_SIGNATURE' : 'NOT_YET_VISIBLE';
    return { id: `pset-${i}`, order: s.order, role: 'SIGNER', status, memberInfos: [{ id: `member-${i}`, email }] };
  });
  if (!m[2] && req.method === 'GET') return json(200, { id: m[1], name: a.body.name, status: a.status });
  if (m[2] === '/members') return json(200, { participantSets: sets() });
  if (m[2] === '/combinedDocument') {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    return res.end('%PDF-1.4 signed copy');
  }
  if (m[2] === '/reminders') { fake.reminders.push(JSON.parse(raw.toString())); return json(201, { id: 'rem-1' }); }
  if (m[2] === '/state' && req.method === 'PUT') {
    const body = JSON.parse(raw.toString());
    fake.cancels.push(body);
    a.status = body.state;
    return json(200, {});
  }
  return json(404, { code: 'NOT_FOUND', message: `unhandled ${req.method} ${p}` });
});

let srv;
let api;
let db;
let adobe;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.ADOBE_SIGN_API_URL = base;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
  adobe = require('../src/services/adobeSign');
});
after(async () => { await srv.close(); server.close(); });

const PDF = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64')}`;
let mia;
let tom;
let deal;
let checklistItem;

test('connecting: needs an admin and a working integration key', async () => {
  assert.equal((await api.get('/signing/status')).data.connected, false);
  assert.equal((await api.post('/signing/requests', { contact_id: 1 })).status, 404);
  const bad = await api.post('/signing/connect', { key: 'wrong-key-0000000000000000' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /didn't accept that integration key/);
  const r = await api.post('/signing/connect', { key: KEY });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { connected: true, account: 'Sam Ford (sam@efh.example)', send_as_user: false });
  const stored = db.getSetting('adobe_sign_key');
  assert.ok(stored.startsWith('v1:') && !stored.includes(KEY), 'key encrypted at rest');

  await api.post('/users', { name: 'Jordan', email: 'jordan@test.local', password: 'password123', role: 'broker' });
  const broker = srv.client();
  await broker.login('jordan@test.local', 'password123');
  assert.equal((await broker.post('/signing/connect', { key: KEY })).status, 403);
  assert.equal((await broker.get('/signing/status')).data.connected, true);
});

test('only Adobe\'s own servers are trusted', () => {
  assert.equal(adobe.trustedBase('https://api.au1.adobesign.com/'), 'https://api.au1.adobesign.com');
  assert.equal(adobe.trustedBase('https://secure.echosign.com'), 'https://secure.echosign.com');
  assert.equal(adobe.trustedBase('https://evil.example/adobesign.com'), null);
  assert.equal(adobe.trustedBase('http://api.au1.adobesign.com'), null);
});

test('setup: a couple with a deal and checklist', async () => {
  mia = (await api.post('/contacts', { first_name: 'Mia', last_name: 'Jones', email: 'mia@example.com' })).data;
  tom = (await api.post(`/contacts/${mia.id}/relationships`, { new_contact: { first_name: 'Tom', email: 'tom@example.com' }, relationship: 'spouse', shared_finances: 1 })).data.related_id;
  deal = (await api.post('/deals', { contact_id: mia.id, loan_purpose: 'purchase', loan_amount: 500000 })).data;
  checklistItem = db.insert('documents', { deal_id: deal.id, name: 'Signed privacy consent', category: 'compliance', status: 'requested' });
});

test('checks before sending', async () => {
  const send = (over) => api.post('/signing/requests', { contact_id: mia.id, file: { name: 'Consent.pdf', data: PDF }, signers: [{ name: 'Mia', email: 'mia@example.com' }], ...over });
  assert.match((await send({ file: { name: 'virus.exe', data: PDF } })).data.error, /PDF or Word/);
  assert.match((await send({ file: { name: 'fake.pdf', data: 'data:application/pdf;base64,aGVsbG8=' } })).data.error, /doesn't look like a PDF/);
  assert.match((await send({ file: null })).data.error, /Choose a document/);
  assert.match((await send({ signers: [] })).data.error, /at least one person/);
  assert.match((await send({ signers: [{ name: 'Mia', email: 'nope' }] })).data.error, /valid email/);
  assert.match((await send({ signers: [{ email: 'mia@example.com' }, { email: 'MIA@example.com' }] })).data.error, /listed twice/);
  const other = (await api.post('/contacts', { first_name: 'Other' })).data;
  const otherDeal = (await api.post('/deals', { contact_id: other.id })).data;
  assert.match((await send({ deal_id: otherDeal.id })).data.error, /different client/);
  assert.match((await send({ deal_id: deal.id, document_id: 99999 })).data.error, /isn't on this deal/);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM sign_requests').n, 0, 'nothing recorded for rejected requests');
});

test('sending a document to a couple, in order, with the broker countersigning', async () => {
  const r = await api.post('/signing/requests', {
    contact_id: mia.id, deal_id: deal.id, document_id: checklistItem, name: 'Privacy consent', message: 'Please sign, thanks!',
    file: { name: 'Consent form.pdf', data: PDF }, order: 'sequential', broker_signs: true, reminder: 'every_3_days', expires_days: 14,
    signers: [{ name: 'Mia Jones', email: 'mia@example.com', contact_id: mia.id }, { name: 'Tom Jones', email: 'tom@example.com', contact_id: tom }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'out_for_signature');
  assert.equal(r.data.has_signed_pdf, false);
  assert.deepEqual(r.data.signers.map((s) => [s.name, s.order, s.status]), [['Mia Jones', 1, 'waiting'], ['Tom Jones', 2, 'not_yet'], ['Admin User', 3, 'not_yet']]);
  assert.deepEqual(fake.uploads[0], { fileName: 'Consent form.pdf', hasPdf: true });
  const sent = [...fake.agreements.values()][0].body;
  assert.equal(sent.name, 'Privacy consent');
  assert.equal(sent.signatureType, 'ESIGN');
  assert.equal(sent.state, 'IN_PROCESS');
  assert.equal(sent.message, 'Please sign, thanks!');
  assert.equal(sent.reminderFrequency, 'EVERY_THIRD_DAY_UNTIL_SIGNED');
  assert.deepEqual(sent.participantSetsInfo.map((s) => [s.memberInfos[0].email, s.order, s.role]), [['mia@example.com', 1, 'SIGNER'], ['tom@example.com', 2, 'SIGNER'], ['admin@test.local', 3, 'SIGNER']]);
  assert.ok(Date.parse(sent.expirationTime) > Date.now() + 13 * 86400000);
  assert.equal(fake.users.every((u) => u === null), true, 'sent from the connected account');

  const c = (await api.get(`/contacts/${mia.id}`)).data;
  assert.equal(c.sign_requests.length, 1);
  assert.ok(c.activities.some((a) => a.body === 'Sent for signing via Adobe Sign: Privacy consent (to Mia Jones, Tom Jones, then you)'));
  assert.equal((await api.get(`/contacts/${tom}`)).data.sign_requests.length, 1, 'shows for the partner too');
  assert.equal((await api.get(`/deals/${deal.id}`)).data.sign_requests.length, 1);
});

test('progress is tracked; reminders go to whoever is waiting', async () => {
  const req = db.one('SELECT * FROM sign_requests');
  const a = fake.agreements.get(req.agreement_id);
  a.signed.add('mia@example.com');
  const r = (await api.post(`/signing/requests/${req.id}/refresh`, {})).data;
  assert.deepEqual(r.signers.map((s) => s.status), ['signed', 'waiting', 'not_yet']);
  assert.equal(r.status, 'out_for_signature');
  const rem = await api.post(`/signing/requests/${req.id}/remind`, { note: 'Just a nudge' });
  assert.equal(rem.data.reminded, 1);
  assert.deepEqual(fake.reminders[0], { recipientParticipantIds: ['member-1'], status: 'ACTIVE', note: 'Just a nudge' });
});

test('when everyone has signed: signed copy kept, logged, checklist ticked, automations fired', async () => {
  const auto = (await api.post('/automations', { name: 'Thank them', trigger: 'document.signed', actions: [{ type: 'create_task', title: 'File {{event.document_name}} for {{contact.first_name}}' }] })).data;
  assert.ok(auto.id);
  const req = db.one('SELECT * FROM sign_requests');
  const a = fake.agreements.get(req.agreement_id);
  ['tom@example.com', 'admin@test.local'].forEach((e) => a.signed.add(e));
  a.status = 'SIGNED';
  // The scheduler checks requests not looked at in the last 10 minutes.
  db.run("UPDATE sign_requests SET last_checked_at = '2000-01-01T00:00:00.000Z'");
  assert.equal(await adobe.syncOpen({ error() {} }), 1);
  const r = adobe.get(req.id);
  assert.equal(r.status, 'signed');
  assert.ok(r.completed_at);
  assert.ok(r.signers.every((s) => s.status === 'signed'));
  assert.equal(db.one('SELECT status FROM documents WHERE id = ?', checklistItem).status, 'received');
  assert.ok(db.one("SELECT 1 FROM activities WHERE contact_id = ? AND body = 'Document signed: Privacy consent (Adobe Sign)'", mia.id));
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message = 'Document signed: Privacy consent – Mia Jones'"));
  assert.ok(db.one("SELECT 1 FROM tasks WHERE title = 'File Privacy consent for Mia'"));

  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const pdf = await fetch(`${srv.base}/signing/requests/${req.id}/signed.pdf`, { headers: { Cookie: cookie } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /Privacy consent \(signed\)\.pdf/);
  assert.equal(await pdf.text(), '%PDF-1.4 signed copy');
  // Finished requests aren't checked again, chased or cancelled.
  assert.equal(await adobe.syncOpen({ error() {} }), 0);
  assert.equal((await api.post(`/signing/requests/${req.id}/remind`, {})).status, 400);
  assert.equal((await api.post(`/signing/requests/${req.id}/cancel`, {})).status, 400);
});

test('lending reviews can be sent; cancelling and declines are recorded', async () => {
  const review = (await api.post('/reviews', { contact_id: mia.id })).data;
  const r = (await api.post('/signing/requests', { contact_id: mia.id, review_id: review.id, signers: [{ name: 'Mia', email: 'mia@example.com' }] })).data;
  assert.match(r.file_name, /\.pdf$/);
  assert.equal(fake.uploads[fake.uploads.length - 1].hasPdf, true, 'the review PDF was generated and uploaded');
  const cancelled = (await api.post(`/signing/requests/${r.id}/cancel`, { reason: 'Sent the wrong version' })).data;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(fake.cancels[0], { state: 'CANCELLED', agreementCancellationInfo: { comment: 'Sent the wrong version', notifyOthers: true } });

  const d = (await api.post('/signing/requests', { contact_id: mia.id, file: { name: 'Form.pdf', data: PDF }, signers: [{ name: 'Mia', email: 'mia@example.com' }] })).data;
  const a = fake.agreements.get(db.one('SELECT agreement_id FROM sign_requests WHERE id = ?', d.id).agreement_id);
  a.declined = 'mia@example.com';
  a.status = 'CANCELLED';
  assert.equal((await api.post(`/signing/requests/${d.id}/refresh`, {})).data.status, 'declined');
  assert.ok(db.one("SELECT 1 FROM activities WHERE body = 'Document declined: Form (Adobe Sign)'"));
});

test('Adobe errors are reported without signing the broker out', async () => {
  const r = await api.post('/signing/requests', { contact_id: mia.id, name: 'Make Adobe fail', file: { name: 'x.pdf', data: PDF }, signers: [{ name: 'Mia', email: 'mia@example.com' }] });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /One of the participants is invalid/);
  assert.equal(db.one("SELECT status FROM sign_requests WHERE name = 'Make Adobe fail'").status, 'failed');

  db.setSetting('adobe_sign_key', require('../src/secrets').encrypt('revoked-key-000000000000000'));
  const revoked = await api.post('/signing/requests', { contact_id: mia.id, file: { name: 'x.pdf', data: PDF }, signers: [{ name: 'Mia', email: 'mia@example.com' }] });
  assert.equal(revoked.status, 502);
  assert.match(revoked.data.error, /rejected the integration key/);
  assert.equal((await api.get('/signing/status')).status, 200, 'still signed in to the CRM');
});

test('sending as each team member, and disconnecting', async () => {
  await api.post('/signing/connect', { key: KEY });
  await api.put('/signing/settings', { send_as_user: true });
  fake.users.length = 0;
  await api.post('/signing/requests', { contact_id: mia.id, file: { name: 'y.pdf', data: PDF }, signers: [{ name: 'Mia', email: 'mia@example.com' }] });
  assert.ok(fake.users.includes('email:admin@test.local'));
  await api.post('/signing/disconnect', {});
  assert.equal((await api.get('/signing/status')).data.connected, false);
  assert.equal(db.getSetting('adobe_sign_key'), '');
});
