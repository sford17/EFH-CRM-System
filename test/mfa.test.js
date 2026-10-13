'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let srv;
let db;
let mfa;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  mfa = require('../src/services/mfa');
});
after(() => srv.close());

// A small client that keeps every cookie (session and "remember this device").
function browser() {
  const jar = new Map();
  const call = async (method, path, body) => {
    const res = await fetch(srv.base + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { jar, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
const codeFor = (key, offset = 0) => mfa.codeAt(mfa.unbase32(key), mfa.stepNow() + offset);

test('codes match the authenticator standard (RFC 6238 test values)', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.equal(mfa.codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(mfa.codeAt(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(mfa.codeAt(secret, Math.floor(2000000000 / 30)), '279037');
  assert.equal(mfa.base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(mfa.unbase32('mzxw 6ytb oi'), Buffer.from('foobar'));
  // Clock drift of one step either way is fine; a used step can't be reused.
  const now = 59 * 1000;
  assert.equal(mfa.matchStep(secret, '287082', 0, now), 1);
  assert.equal(mfa.matchStep(secret, '287082', 1, now), null, 'already used');
  assert.equal(mfa.matchStep(secret, '28708', 0, now), null);
});

let admin;
let key;
let recovery;
test('setting it up: QR code, confirm with a code, recovery codes, other sessions signed out', async () => {
  admin = browser();
  await admin.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
  const other = browser();
  await other.post('/auth/login', { email: 'admin@test.local', password: 'password123' });

  assert.equal((await admin.get('/auth/2fa')).data.enabled, false);
  const s = (await admin.post('/auth/2fa/start')).data;
  key = s.key.replace(/\s/g, '');
  assert.match(s.key, /^([A-Z2-7]{4} )+[A-Z2-7]{0,4}$/);
  assert.match(s.url, /^otpauth:\/\/totp\/EFH%20Mortgage%20Broking%3Aadmin%40test\.local\?secret=[A-Z2-7]+&issuer=EFH%20Mortgage%20Broking/);
  assert.match(s.qr_svg, /^<svg/);
  assert.equal(db.one('SELECT totp_enabled_at FROM users WHERE email = ?', 'admin@test.local').totp_enabled_at, null, 'not on until confirmed');

  assert.equal((await admin.post('/auth/2fa/confirm', { code: '000000' })).status, 400);
  const r = await admin.post('/auth/2fa/confirm', { code: codeFor(key) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  recovery = r.data.recovery_codes;
  assert.equal(recovery.length, 10);
  assert.match(recovery[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal(r.data.status.enabled, true);
  const row = db.one('SELECT totp_secret, totp_recovery FROM users WHERE email = ?', 'admin@test.local');
  assert.ok(!row.totp_secret.includes(key), 'secret stored encrypted');
  assert.ok(!row.totp_recovery.includes(recovery[0]), 'recovery codes stored hashed');
  assert.equal((await admin.get('/contacts')).status, 200, 'this session carries on');
  assert.equal((await other.get('/contacts')).status, 401, 'other sessions signed out');
});

test('signing in: password, then a code; wrong codes are limited; codes can\'t be reused', async () => {
  const b = browser();
  const step1 = await b.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
  assert.equal(step1.data.mfa_required, true);
  assert.ok(step1.data.challenge);
  assert.equal((await b.get('/contacts')).status, 401, 'no session yet');
  assert.equal((await b.post('/auth/login/mfa', { challenge: step1.data.challenge, code: '111111' })).status, 401);
  assert.equal((await b.post('/auth/login/mfa', { challenge: 'made-up', code: codeFor(key) })).status, 401);
  // The code just used to set up can't be used again; wait for the next one by using next step's code.
  const ok = await b.post('/auth/login/mfa', { challenge: step1.data.challenge, code: codeFor(key, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.email, 'admin@test.local');
  assert.equal((await b.get('/contacts')).status, 200);
  assert.equal((await b.post('/auth/login/mfa', { challenge: step1.data.challenge, code: codeFor(key, 1) })).status, 401, 'ticket used up');

  const c = browser();
  const t = (await c.post('/auth/login', { email: 'admin@test.local', password: 'password123' })).data.challenge;
  assert.equal((await c.post('/auth/login/mfa', { challenge: t, code: codeFor(key, 1) })).status, 401, 'same code twice');
  for (let i = 0; i < 4; i += 1) await c.post('/auth/login/mfa', { challenge: t, code: '123456' });
  assert.equal((await c.post('/auth/login/mfa', { challenge: t, code: '123456' })).status, 429, 'five tries per sign-in');
});

test('recovery codes work once; "remember this device" skips the code for 30 days', async () => {
  const b = browser();
  let t = (await b.post('/auth/login', { email: 'admin@test.local', password: 'password123' })).data.challenge;
  const r = await b.post('/auth/login/mfa', { challenge: t, code: recovery[0].toUpperCase(), remember: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.used_recovery_code, r.data.recovery_left], [true, 9]);
  assert.ok(b.jar.has('efh_trusted'), 'remembered');

  const again = await b.post('/auth/login', { email: 'admin@test.local', password: 'password123' });
  assert.equal(again.data.mfa_required, undefined, 'no code needed on this device');
  assert.equal(again.data.user.email, 'admin@test.local');

  const fresh = browser();
  t = (await fresh.post('/auth/login', { email: 'admin@test.local', password: 'password123' })).data.challenge;
  assert.equal((await fresh.post('/auth/login/mfa', { challenge: t, code: recovery[0] })).status, 401, 'used already');

  assert.equal((await b.post('/auth/2fa/forget-devices')).data.forgotten, 1);
  assert.equal((await b.post('/auth/login', { email: 'admin@test.local', password: 'password123' })).data.mfa_required, true);
  // New recovery codes need the password.
  assert.equal((await admin.post('/auth/2fa/recovery-codes', { password: 'wrong' })).status, 400);
  recovery = (await admin.post('/auth/2fa/recovery-codes', { password: 'password123' })).data.recovery_codes;
  assert.equal((await admin.get('/auth/2fa')).data.recovery_left, 10);
});

test('requiring it for everyone: others set it up at their next sign-in', async () => {
  await admin.post('/users', { name: 'Bea Broker', email: 'bea@test.local', password: 'password123', role: 'broker' });
  const bea = browser();
  await bea.post('/auth/login', { email: 'bea@test.local', password: 'password123' });
  assert.equal((await bea.put('/auth/2fa/required', { required: true })).status, 403, 'admins only');
  assert.equal((await admin.put('/auth/2fa/required', { required: true })).data.required, true);

  const blocked = await bea.get('/contacts');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.reason, 'mfa_setup_required');
  assert.equal((await bea.get('/auth/status')).data.mfa_setup_required, true);
  const s = (await bea.post('/auth/2fa/start')).data;
  const beaKey = s.key.replace(/\s/g, '');
  assert.equal((await bea.post('/auth/2fa/confirm', { code: codeFor(beaKey) })).status, 200);
  assert.equal((await bea.get('/contacts')).status, 200);
  assert.equal((await bea.post('/auth/2fa/disable', { password: 'password123' })).status, 400, 'can\'t turn off while required');

  // Lost phone: an admin resets it; she's signed out and sets it up again.
  const beaId = db.one("SELECT id FROM users WHERE email = 'bea@test.local'").id;
  assert.equal((await admin.post(`/auth/2fa/reset/${beaId}`)).status, 200);
  assert.equal((await bea.get('/contacts')).status, 401);
  const back = await bea.post('/auth/login', { email: 'bea@test.local', password: 'password123' });
  assert.equal(back.data.mfa_required, undefined);
  assert.equal((await bea.get('/auth/status')).data.mfa_setup_required, true);
  const users = (await admin.get('/users')).data.rows;
  assert.equal(users.find((u) => u.email === 'bea@test.local').mfa_enabled, 0);
  assert.equal(users.find((u) => u.email === 'admin@test.local').mfa_enabled, 1);

  await admin.put('/auth/2fa/required', { required: false });
  assert.equal((await admin.post('/auth/2fa/disable', { password: 'password123' })).data.enabled, false);
});
