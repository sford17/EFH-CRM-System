'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let db;
let admin;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  admin = srv.client();
  await admin.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
  db.setSetting('business_name', 'EFH Mortgage Broking');
  db.setSetting('app_url', 'https://efh-crm.fly.dev');
});
after(() => srv.close());

const tokenFrom = (link) => link.split('/#/welcome/')[1];

test('adding someone without a password and emailing them a welcome link', async () => {
  assert.equal((await admin.post('/users', { name: 'Bea Broker', email: 'admin@test.local', role: 'broker' })).status, 409, 'email already used');
  const created = await admin.post('/users', { name: 'Bea Broker', email: 'bea@test.local', role: 'broker' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const bea = srv.client();
  assert.equal((await bea.post('/auth/login', { email: 'bea@test.local', password: '' })).status, 401, 'no usable password yet');

  const r = await admin.post(`/users/${created.data.id}/welcome`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'welcome');
  // No Outlook or SMTP in tests, so it's logged and the admin gets the link to pass on.
  assert.equal(r.data.status, 'logged');
  assert.match(r.data.link, /^https:\/\/efh-crm\.fly\.dev\/#\/welcome\/[\w-]{40,}$/);
  const mail = db.one('SELECT * FROM outbox ORDER BY id DESC LIMIT 1');
  assert.equal(mail.to_email, 'bea@test.local');
  assert.equal(mail.subject, 'Welcome to the EFH Mortgage Broking CRM');
  assert.match(mail.body, /Hi Bea,/);
  assert.match(mail.body, /\[\[button: Choose your password \| https:\/\/efh-crm\.fly\.dev\/#\/welcome\/\(one-time link, removed after sending\)\]\]/);
  assert.ok(!mail.body.includes(tokenFrom(r.data.link)), 'the link isn\'t left in the Outbox');
  assert.match(mail.body, /Connect Outlook/);

  const list = (await admin.get('/users')).data.rows.find((u) => u.email === 'bea@test.local');
  assert.equal(list.last_login_at, null);
  assert.ok(list.link_sent_at);
  assert.equal((await bea.post(`/users/${created.data.id}/welcome`, {})).status, 401, 'needs a session');
});

test('the link: choose a password once, then signed in; old and used links stop working', async () => {
  const id = db.one("SELECT id FROM users WHERE email = 'bea@test.local'").id;
  const first = tokenFrom((await admin.post(`/users/${id}/welcome`, {})).data.link);
  const second = tokenFrom((await admin.post(`/users/${id}/welcome`, {})).data.link);
  const bea = srv.client();
  assert.equal((await bea.get(`/auth/welcome/${first}`)).status, 410, 'a newer link replaces it');
  const info = await bea.get(`/auth/welcome/${second}`);
  assert.deepEqual([info.data.kind, info.data.name, info.data.email], ['welcome', 'Bea Broker', 'bea@test.local']);
  assert.equal((await bea.post(`/auth/welcome/${second}`, { password: 'short' })).status, 400);
  const ok = await bea.post(`/auth/welcome/${second}`, { password: 'harbour-view-42' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.email, 'bea@test.local');
  assert.equal((await bea.get('/contacts')).status, 200, 'signed in');
  assert.equal((await srv.client().post(`/auth/welcome/${second}`, { password: 'another-one-99' })).status, 410, 'used up');
  assert.equal((await srv.client().post('/auth/login', { email: 'bea@test.local', password: 'harbour-view-42' })).status, 200);
  assert.ok((await admin.get('/users')).data.rows.find((u) => u.id === id).last_login_at, 'shows as signed in');
});

test('someone who has signed in before gets a password link; two-factor still applies', async () => {
  const id = db.one("SELECT id FROM users WHERE email = 'bea@test.local'").id;
  const r = await admin.post(`/users/${id}/welcome`, {});
  assert.equal(r.data.kind, 'reset');
  assert.match(db.one('SELECT subject FROM outbox ORDER BY id DESC LIMIT 1').subject, /^Choose a new password/);
  db.update('users', id, { totp_enabled_at: new Date().toISOString(), totp_secret: require('../src/secrets').encrypt('00'.repeat(20)) });
  const res = await srv.client().post(`/auth/welcome/${tokenFrom(r.data.link)}`, { password: 'new-harbour-77' });
  assert.equal(res.data.mfa_required, true, 'needs the code before a session');
  assert.ok(res.data.challenge);
  assert.equal(res.data.user, undefined);

  db.update('users', id, { active: 0 });
  assert.equal((await admin.post(`/users/${id}/welcome`, {})).status, 400, 'inactive');
  assert.equal((await admin.post('/users/9999/welcome', {})).status, 404);
});
