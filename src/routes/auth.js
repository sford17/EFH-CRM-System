'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { HttpError } = require('../util');
const { pick, requireFields, intParam } = require('./helpers');
const mfa = require('../services/mfa');

const router = express.Router();

// Tracks failed logins per email to slow down password guessing.
const failures = new Map();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

router.get('/status', (req, res) => {
  const hasUsers = !!db.one('SELECT 1 FROM users LIMIT 1');
  const brand = require('../services/branding').getBrand();
  const user = auth.sessionUser(req);
  res.json({
    needs_setup: !hasUsers,
    user,
    mfa_setup_required: Boolean(user && !user.mfa_enabled && mfa.required()),
    brand: { business_name: brand.business_name, logo: brand.logo?.url || null, version: brand.version },
  });
});

// Creates the first admin account. Only works while there are no users.
router.post('/setup', (req, res) => {
  if (db.one('SELECT 1 FROM users LIMIT 1')) throw new HttpError(409, 'Setup has already been completed');
  const body = pick(req.body, ['name', 'email', 'password', 'business_name']);
  requireFields(body, ['name', 'email', 'password']);
  if (String(body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const id = db.insert('users', { name: body.name, email: body.email, password_hash: auth.hashPassword(body.password), role: 'admin' });
  if (body.business_name) db.setSetting('business_name', body.business_name);
  const session = auth.createSession(id);
  auth.setSessionCookie(res, session.token, session.expires);
  res.status(201).json({ user: db.one('SELECT id, name, email, role FROM users WHERE id = ?', id) });
});

router.post('/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const f = failures.get(email);
  if (f && f.count >= MAX_FAILURES && Date.now() - f.at < LOCK_MS) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
  const user = db.one('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!user || !auth.verifyPassword(req.body?.password, user.password_hash)) {
    failures.set(email, { count: (f && Date.now() - f.at < LOCK_MS ? f.count : 0) + 1, at: Date.now() });
    throw new HttpError(401, 'Incorrect email or password');
  }
  failures.delete(email);
  // Two-factor: unless this browser is remembered, ask for a code next.
  if (user.totp_enabled_at && !mfa.isTrusted(user.id, auth.readCookie(req, mfa.TRUST_COOKIE))) {
    return res.json({ mfa_required: true, challenge: mfa.challenge(user.id) });
  }
  const session = auth.createSession(user.id);
  auth.setSessionCookie(res, session.token, session.expires);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// The second step: a code from the authenticator app (or a recovery code).
router.post('/login/mfa', (req, res) => {
  const challenge = String(req.body?.challenge || '');
  const row = db.one('SELECT user_id FROM mfa_challenges WHERE token_hash = ?', require('node:crypto').createHash('sha256').update(challenge).digest('hex'));
  const key = `mfa:${row?.user_id ?? 'unknown'}`;
  const f = failures.get(key);
  if (f && f.count >= MAX_FAILURES * 2 && Date.now() - f.at < LOCK_MS) throw new HttpError(429, 'Too many wrong codes. Try again in 15 minutes.');
  let result;
  try {
    result = mfa.verifyChallenge(challenge, req.body?.code);
  } catch (err) {
    if (err.status === 401 && row) failures.set(key, { count: (f && Date.now() - f.at < LOCK_MS ? f.count : 0) + 1, at: Date.now() });
    throw err;
  }
  failures.delete(key);
  const user = db.one('SELECT id, name, email, role FROM users WHERE id = ? AND active = 1', result.userId);
  if (!user) throw new HttpError(401, 'Incorrect email or password');
  const session = auth.createSession(user.id);
  auth.setSessionCookie(res, session.token, session.expires);
  if (req.body?.remember) {
    const t = mfa.trustDevice(user.id, req.headers['user-agent']);
    mfa.trustCookie(res, t.token, t.expires);
  }
  res.json({ user, used_recovery_code: result.usedRecovery, recovery_left: result.recoveryLeft });
});

router.post('/logout', (req, res) => {
  const token = auth.readCookie(req, auth.COOKIE);
  if (token) db.run('DELETE FROM sessions WHERE token = ?', token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireSession, (req, res) => res.json({ user: req.user }));

router.post('/change-password', auth.requireAuth, (req, res) => {
  const user = db.one('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(req.body?.current_password, user.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(req.body?.new_password || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  db.update('users', user.id, { password_hash: auth.hashPassword(req.body.new_password) });
  res.json({ ok: true });
});

// ---- Two-factor set-up (for yourself) and admin controls -------------------------------------------
router.get('/2fa', auth.requireSession, (req, res) => res.json(mfa.status(req.user.id)));
router.post('/2fa/start', auth.requireSession, async (req, res) => res.json(await mfa.start(req.user.id)));
router.post('/2fa/confirm', auth.requireSession, (req, res) => {
  const r = mfa.confirm(req.user.id, req.body?.code, { keepSession: auth.readCookie(req, auth.COOKIE) });
  res.json({ ...r, status: mfa.status(req.user.id) });
});
router.post('/2fa/recovery-codes', auth.requireAuth, (req, res) => res.json(mfa.regenerateRecovery(req.user.id, req.body?.password)));
router.post('/2fa/disable', auth.requireAuth, (req, res) => res.json(mfa.disable(req.user.id, req.body?.password)));
router.post('/2fa/forget-devices', auth.requireAuth, (req, res) => res.json({ forgotten: mfa.forgetDevices(req.user.id) }));
router.put('/2fa/required', auth.requireAuth, auth.requireRole('admin'), (req, res) => res.json({ required: mfa.setRequired(Boolean(req.body?.required), req.user.id) }));
router.post('/2fa/reset/:userId', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
  mfa.reset(intParam(req.params.userId), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
