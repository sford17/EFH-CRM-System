'use strict';
// Exercises the Outlook integration against a fake Microsoft identity + Graph server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const fake = {
  messages: { inbox: [], sentitems: [] },
  sent: [],
  replies: [],
  tokenCalls: [],
  failNextGraphWith401: false,
};

const graphServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body ? JSON.stringify(body) : ''); };

  if (url.pathname.endsWith('/oauth2/v2.0/token')) {
    const p = new URLSearchParams(raw);
    fake.tokenCalls.push(Object.fromEntries(p));
    if (p.get('client_secret') !== 'shh') return json(401, { error: 'invalid_client', error_description: 'Bad secret' });
    if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'Bad code' });
    return json(200, { access_token: `tok-${fake.tokenCalls.length}`, refresh_token: `ref-${fake.tokenCalls.length}`, expires_in: 3600 });
  }
  if (!String(req.headers.authorization || '').startsWith('Bearer tok-')) return json(401, { error: { message: 'no token' } });
  if (fake.failNextGraphWith401) { fake.failNextGraphWith401 = false; return json(401, { error: { message: 'expired' } }); }
  assert.match(req.headers.prefer, /ImmutableId/);

  if (url.pathname === '/v1.0/me') return json(200, { displayName: 'Admin User', mail: 'Admin@Broker.example' });
  const folder = url.pathname.match(/^\/v1\.0\/me\/mailFolders\/(\w+)\/messages$/);
  if (folder) {
    const filter = url.searchParams.get('$filter');
    assert.match(filter, /^(receivedDateTime|sentDateTime) ge \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    return json(200, { value: fake.messages[folder[1]] });
  }
  if (req.method === 'POST' && url.pathname === '/v1.0/me/messages') {
    const draft = JSON.parse(raw);
    const id = `draft-${fake.sent.length + 1}`;
    fake.sent.push({ id, ...draft, sent: false });
    return json(201, { id, conversationId: `conv-${id}`, webLink: `https://outlook.office.com/${id}` });
  }
  const send = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)\/send$/);
  const draft = send && fake.sent.find((m) => m.id === decodeURIComponent(send[1]));
  if (draft) { draft.sent = true; return json(202); }
  const createReply = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+)\/createReply$/);
  if (createReply) {
    assert.match(req.headers.prefer, /body-content-type="html"/);
    const id = `reply-${fake.replies.length + 1}`;
    fake.replies.push({ id, inReplyTo: decodeURIComponent(createReply[1]), sent: false, attachments: [] });
    return json(201, { id, body: { contentType: 'html', content: '<html><body dir="ltr"><div>-- original message --</div></body></html>' } });
  }
  const draftMatch = url.pathname.match(/^\/v1\.0\/me\/messages\/([^/]+?)(\/attachments|\/send)?$/);
  const draftReply = draftMatch && fake.replies.find((r) => r.id === decodeURIComponent(draftMatch[1]));
  if (draftReply) {
    if (req.method === 'PATCH') { draftReply.body = JSON.parse(raw).body; return json(200, {}); }
    if (draftMatch[2] === '/attachments') { draftReply.attachments.push(JSON.parse(raw)); return json(201, {}); }
    if (draftMatch[2] === '/send') { draftReply.sent = true; return json(202); }
  }
  return json(404, { error: { message: `unhandled ${req.method} ${url.pathname}` } });
});

let srv;
let api;
let db;

before(async () => {
  await new Promise((r) => graphServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${graphServer.address().port}`;
  process.env.MS_LOGIN_URL = base;
  process.env.GRAPH_BASE_URL = `${base}/v1.0`;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(async () => { await srv.close(); graphServer.close(); });

const msg = (over) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  conversationId: 'c1',
  subject: 'Re: my loan',
  bodyPreview: 'Here are my payslips',
  body: { contentType: 'text', content: 'Here are my payslips\n\nThanks' },
  from: { emailAddress: { address: 'client@example.com', name: 'Cli Ent' } },
  toRecipients: [{ emailAddress: { address: 'admin@broker.example' } }],
  ccRecipients: [],
  receivedDateTime: new Date().toISOString(),
  sentDateTime: new Date().toISOString(),
  hasAttachments: true,
  webLink: 'https://outlook.office.com/abc',
  ...over,
});

test('connecting needs the app to be configured by an admin', async () => {
  const r = await api.post('/outlook/connect');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not been set up/);
  assert.equal((await api.put('/outlook/config', { tenant: 'bad/tenant' })).status, 400);
  await api.put('/outlook/config', { client_id: 'app-123', client_secret: 'shh', tenant: 'contoso.onmicrosoft.com' });
  const status = (await api.get('/outlook/status')).data;
  assert.equal(status.configured, true);
  assert.deepEqual(status.app, { client_id: 'app-123', tenant: 'contoso.onmicrosoft.com', has_secret: true });
  const stored = db.getSetting('outlook_client_secret');
  assert.ok(stored.startsWith('v1:') && !stored.includes('shh'), 'client secret encrypted at rest');
});

test('OAuth connect flow stores encrypted tokens for the user', async () => {
  const { url } = (await api.post('/outlook/connect')).data;
  const auth = new URL(url);
  assert.equal(auth.pathname, '/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
  assert.equal(auth.searchParams.get('client_id'), 'app-123');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(auth.searchParams.get('scope'), /Mail\.Send/);
  assert.match(auth.searchParams.get('redirect_uri'), /\/api\/outlook\/callback$/);
  const state = auth.searchParams.get('state');

  // Callback works without a session cookie (SameSite=Strict isn't sent cross-site).
  const bad = await fetch(`${srv.base}/outlook/callback?code=good-code&state=forged`);
  assert.match(await bad.text(), /expired/);
  const ok = await fetch(`${srv.base}/outlook/callback?code=good-code&state=${state}`);
  const html = await ok.text();
  assert.match(html, /admin@broker\.example is connected/);
  const replay = await fetch(`${srv.base}/outlook/callback?code=good-code&state=${state}`);
  assert.match(await replay.text(), /expired/, 'state is single use');

  const exchange = fake.tokenCalls.find((c) => c.grant_type === 'authorization_code');
  assert.ok(exchange.code_verifier, 'PKCE verifier sent');
  const account = db.one('SELECT * FROM mail_accounts');
  assert.equal(account.email, 'admin@broker.example');
  assert.ok(account.access_token.startsWith('v1:') && account.refresh_token.startsWith('v1:'));
  assert.equal((await api.get('/outlook/status')).data.account.connected, true);
});

test('initial sync files client emails only, without alerts', async () => {
  const client = (await api.post('/contacts', { first_name: 'Cli', last_name: 'Ent', email: 'Client@Example.com', status: 'prospect' })).data;
  const deal = (await api.post('/deals', { contact_id: client.id, loan_amount: 500000 })).data;
  fake.messages.inbox = [msg({ id: 'in-1' }), msg({ id: 'spam', from: { emailAddress: { address: 'newsletter@shop.example' } } })];
  fake.messages.sentitems = [msg({
    id: 'out-1', subject: 'Your documents', from: { emailAddress: { address: 'admin@broker.example' } },
    toRecipients: [{ emailAddress: { address: 'someone@else.example' } }], ccRecipients: [{ emailAddress: { address: 'client@example.com' } }],
  })];
  const notesBefore = db.one('SELECT COUNT(*) AS n FROM notifications').n;
  const r = (await api.post('/outlook/sync')).data;
  assert.equal(r.imported, 2);
  assert.equal(r.initial, true);
  assert.equal(db.one('SELECT COUNT(*) AS n FROM emails').n, 2);
  assert.equal(db.one("SELECT 1 AS x FROM emails WHERE graph_id = 'spam'"), undefined, 'non-contacts ignored');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM notifications').n, notesBefore, 'no alerts for historical import');

  const detail = (await api.get(`/contacts/${client.id}`)).data;
  assert.equal(detail.mail.length, 2);
  const inbound = detail.mail.find((e) => e.direction === 'in');
  assert.equal(inbound.deal_id, deal.id, 'linked to the only open deal');
  assert.ok(detail.activities.some((a) => a.type === 'email' && a.email_id && /Email received: Re: my loan/.test(a.body)));
  assert.ok(detail.last_contacted_at, 'outbound email counts as contact');

  const full = (await api.get(`/emails/${inbound.id}`)).data;
  assert.match(full.body_text, /Here are my payslips/);
  assert.equal(full.can_reply, true);
  assert.equal(full.graph_id, undefined);

  // Re-sync doesn't duplicate.
  await api.post('/outlook/sync');
  assert.equal(db.one('SELECT COUNT(*) AS n FROM emails').n, 2);
});

test('new inbound email notifies the owner and fires email.received automations', async () => {
  await api.post('/automations', {
    name: 'Client replied', trigger: 'email.received',
    actions: [{ type: 'create_task', title: 'Reply to {{contact.first_name}}: {{event.subject}}', due_in_days: 0 }],
  });
  fake.messages.inbox = [msg({ id: 'in-2', subject: 'Question about rates' })];
  fake.messages.sentitems = [];
  await api.post('/outlook/sync');
  const notes = (await api.get('/notifications')).data.rows;
  assert.ok(notes.some((n) => n.message === 'Email from Cli Ent: Question about rates'));
  assert.ok(db.one("SELECT 1 AS x FROM tasks WHERE title = 'Reply to Cli: Question about rates'"));
});

test('emails sent from the CRM go out through Outlook and are logged once', async () => {
  const client = db.one("SELECT id FROM contacts WHERE email = 'Client@Example.com'");
  const r = await api.post('/outbox', { contact_id: client.id, subject: 'Rate update', body: 'Hi Cli,\nRates dropped.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'sent');
  assert.equal(r.data.sent_via, 'outlook');
  const draft = fake.sent.at(-1);
  assert.equal(draft.sent, true);
  assert.equal(draft.toRecipients[0].emailAddress.address, 'Client@Example.com');
  assert.equal(draft.body.contentType, 'HTML');
  assert.match(draft.body.content, /<p style="[^"]*">Hi Cli,<br>Rates dropped\.<\/p>/);
  assert.match(draft.body.content, /Admin User<br>EFH Mortgage Broking<br>0400 111 222/, 'fallback signature');

  const stored = db.one("SELECT * FROM emails WHERE subject = 'Rate update'");
  assert.equal(stored.direction, 'out');
  // When the sync later sees the same message in Sent Items, it is not duplicated.
  fake.messages.inbox = [];
  fake.messages.sentitems = [msg({ id: draft.id, subject: 'Rate update', from: { emailAddress: { address: 'admin@broker.example' } }, toRecipients: [{ emailAddress: { address: 'client@example.com' } }] })];
  await api.post('/outlook/sync');
  assert.equal(db.one("SELECT COUNT(*) AS n FROM emails WHERE subject = 'Rate update'").n, 1);
  assert.equal(db.one("SELECT COUNT(*) AS n FROM activities WHERE body = 'Email sent: Rate update'").n, 1);

  const contact = (await api.get(`/contacts/${client.id}`)).data;
  assert.ok(!contact.emails.some((e) => e.subject === 'Rate update'), 'not repeated in the outbox list');

  const noEmail = (await api.post('/contacts', { first_name: 'No', status: 'lead' })).data;
  assert.equal((await api.post('/outbox', { contact_id: noEmail.id, subject: 'x', body: 'y' })).status, 400);
});

test('file attachments (e.g. a review PDF) go out as regular attachments', async () => {
  const mailer = require('../src/services/mailer');
  const client = db.one("SELECT id FROM contacts WHERE email = 'Client@Example.com'");
  const user = db.one("SELECT id FROM users WHERE email = 'admin@test.local'");
  mailer.queueEmail({ to: 'Client@Example.com', subject: 'Your review', body: 'Attached.', contactId: client.id, senderUserId: user.id,
    attachments: [{ filename: 'Review.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.3 test') }] });
  await mailer.processOutbox();
  const draft = fake.sent.at(-1);
  const file = draft.attachments.find((a) => a.name === 'Review.pdf');
  assert.ok(file, 'attachment sent');
  assert.equal(file.isInline, false);
  assert.equal(Buffer.from(file.contentBytes, 'base64').toString(), '%PDF-1.3 test');
  assert.equal(db.one("SELECT has_attachments FROM emails WHERE subject = 'Your review'").has_attachments, 1);
});

test('replying from the CRM uses the Outlook conversation', async () => {
  const inbound = db.one("SELECT id FROM emails WHERE graph_id = 'in-1'");
  assert.equal((await api.post(`/emails/${inbound.id}/reply`, { body: '  ' })).status, 400);
  const r = await api.post(`/emails/${inbound.id}/reply`, { body: 'Thanks, got them!' });
  assert.equal(r.status, 200);
  const sentReply = fake.replies.at(-1);
  assert.equal(sentReply.inReplyTo, 'in-1');
  assert.equal(sentReply.sent, true);
  assert.match(sentReply.body.content, /^<html><body dir="ltr"><div style="[^"]*"><p[^>]*>Thanks, got them!<\/p>.*Admin User.*<br><div>-- original message --<\/div>/s);

  // Another team member can read it but not reply from someone else's mailbox.
  await api.post('/users', { name: 'Other', email: 'other@test.local', password: 'password123', role: 'broker' });
  const other = srv.client();
  await other.login('other@test.local', 'password123');
  assert.equal((await other.get(`/emails/${inbound.id}`)).data.can_reply, false);
  assert.equal((await other.post(`/emails/${inbound.id}/reply`, { body: 'hi' })).status, 403);
});

test('expired access tokens are refreshed automatically', async () => {
  db.run("UPDATE mail_accounts SET token_expires_at = '2000-01-01T00:00:00.000Z'");
  const before = fake.tokenCalls.filter((c) => c.grant_type === 'refresh_token').length;
  await api.post('/outlook/sync');
  assert.equal(fake.tokenCalls.filter((c) => c.grant_type === 'refresh_token').length, before + 1);
  // A 401 mid-session also triggers one refresh and retry.
  fake.failNextGraphWith401 = true;
  assert.equal((await api.post('/outlook/sync')).status, 200);
});

test('disconnecting stops sending through Outlook but keeps history', async () => {
  await api.post('/outlook/disconnect');
  const account = db.one('SELECT * FROM mail_accounts');
  assert.equal(account.connected, 0);
  assert.equal(account.access_token, null);
  assert.ok(db.one('SELECT COUNT(*) AS n FROM emails').n > 0);
  const client = db.one("SELECT id FROM contacts WHERE email = 'Client@Example.com'");
  const r = await api.post('/outbox', { contact_id: client.id, subject: 'After disconnect', body: 'x' });
  assert.equal(r.data.status, 'logged');
});
