'use strict';
// Two-factor sign-in with an authenticator app (Microsoft Authenticator,
// Google Authenticator, 1Password…): time-based 6-digit codes (RFC 6238),
// one-time recovery codes for a lost phone, and "remember this device".
const crypto = require('node:crypto');
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');

const STEP = 30;
const DIGITS = 6;
const WINDOW = 1; // accept the code either side of now, for clock drift
const CHALLENGE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const TRUST_DAYS = 30;
const TRUST_COOKIE = 'efh_trusted';

// ---- Codes -------------------------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}
const stepNow = (now = Date.now()) => Math.floor(now / 1000 / STEP);

// The time step the code matches (newer than `lastStep`, so a code can't be used twice), or null.
function matchStep(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const s = stepNow(now);
  for (let d = -WINDOW; d <= WINDOW; d += 1) {
    const step = s + d;
    if (step <= (lastStep || 0)) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const normaliseRecovery = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const raw = base32(crypto.randomBytes(5)).toLowerCase(); // 8 characters
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map((c) => hash(normaliseRecovery(c))) };
}

// ---- Status and setup ---------------------------------------------------------------------------------

const required = () => db.getSetting('mfa_required', '0') === '1';
const userRow = (id) => db.one('SELECT id, name, email, password_hash, totp_secret, totp_pending, totp_enabled_at, totp_last_step, totp_recovery FROM users WHERE id = ?', id);

function status(userId) {
  const u = userRow(userId);
  return {
    enabled: Boolean(u.totp_enabled_at), enabled_at: u.totp_enabled_at, required: required(),
    recovery_left: u.totp_recovery ? JSON.parse(u.totp_recovery).length : 0,
    trusted_devices: db.one('SELECT COUNT(*) AS n FROM mfa_trusted WHERE user_id = ? AND expires_at > ?', userId, nowIso()).n,
  };
}

async function start(userId) {
  const u = userRow(userId);
  const secret = crypto.randomBytes(20);
  db.update('users', userId, { totp_pending: encrypt(secret.toString('hex')) });
  const key = base32(secret);
  const issuer = db.getSetting('business_name', '') || 'EFH CRM';
  const url = `otpauth://totp/${encodeURIComponent(`${issuer}:${u.email}`)}?secret=${key}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
  const svg = await require('qrcode').toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { key: key.match(/.{1,4}/g).join(' '), url, qr_svg: svg };
}

function confirm(userId, code, { keepSession = null } = {}) {
  const u = userRow(userId);
  if (!u.totp_pending) throw new HttpError(400, 'Start the set-up again');
  const secret = Buffer.from(decrypt(u.totp_pending), 'hex');
  const step = matchStep(secret, code);
  if (step === null) throw new HttpError(400, 'That code didn\'t match. Check your phone\'s time is set automatically and try the newest code.');
  const { codes, hashes } = newRecoveryCodes();
  db.update('users', userId, {
    totp_secret: u.totp_pending, totp_pending: null, totp_enabled_at: nowIso(), totp_last_step: step, totp_recovery: JSON.stringify(hashes),
  });
  // Sign out everywhere else, so other sessions must use the new second step.
  if (keepSession) db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', userId, keepSession);
  return { recovery_codes: codes };
}

function regenerateRecovery(userId, password) {
  const u = userRow(userId);
  if (!u.totp_enabled_at) throw new HttpError(400, 'Two-factor sign-in isn\'t on');
  if (!require('../auth').verifyPassword(password, u.password_hash)) throw new HttpError(400, 'Your password is incorrect');
  const { codes, hashes } = newRecoveryCodes();
  db.update('users', userId, { totp_recovery: JSON.stringify(hashes) });
  return { recovery_codes: codes };
}

function clear(userId) {
  db.update('users', userId, { totp_secret: null, totp_pending: null, totp_enabled_at: null, totp_last_step: null, totp_recovery: null });
  db.run('DELETE FROM mfa_trusted WHERE user_id = ?', userId);
}

function disable(userId, password) {
  if (required()) throw new HttpError(400, 'Two-factor sign-in is required for everyone in your business, so it can\'t be turned off');
  const u = userRow(userId);
  if (!require('../auth').verifyPassword(password, u.password_hash)) throw new HttpError(400, 'Your password is incorrect');
  clear(userId);
  return status(userId);
}

// An admin resets someone who lost their phone: they set it up again at next sign-in.
function reset(userId, byUserId) {
  if (!db.one('SELECT 1 FROM users WHERE id = ?', userId)) throw new HttpError(404, 'User not found');
  clear(userId);
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  db.insert('activities', { user_id: byUserId, type: 'system', body: `Two-factor sign-in reset for user #${userId}` });
}

function setRequired(on, byUserId) {
  if (on && !userRow(byUserId).totp_enabled_at) throw new HttpError(400, 'Set up two-factor sign-in for yourself first (below), then you can require it for everyone');
  db.setSetting('mfa_required', on ? '1' : '0');
  return required();
}

// ---- Signing in ----------------------------------------------------------------------------------------

// After the password: a short-lived ticket to exchange for a session with a code.
function challenge(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.run('DELETE FROM mfa_challenges WHERE expires_at < ?', nowIso());
  db.insert('mfa_challenges', { token_hash: hash(token), user_id: userId, expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60000).toISOString() });
  return token;
}

// Checks a code (or a recovery code) for a sign-in ticket. Returns the user id.
function verifyChallenge(token, code) {
  const c = db.one('SELECT * FROM mfa_challenges WHERE token_hash = ?', hash(token || ''));
  if (!c || c.expires_at < nowIso()) throw new HttpError(401, 'That sign-in has timed out. Please enter your password again.');
  if (c.attempts >= MAX_ATTEMPTS) {
    db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash);
    throw new HttpError(429, 'Too many wrong codes. Please enter your password again.');
  }
  const u = userRow(c.user_id);
  const secret = Buffer.from(decrypt(u.totp_secret), 'hex');
  const step = matchStep(secret, code, u.totp_last_step || 0);
  let usedRecovery = false;
  if (step !== null) {
    db.update('users', u.id, { totp_last_step: step });
  } else {
    const list = u.totp_recovery ? JSON.parse(u.totp_recovery) : [];
    const h = hash(normaliseRecovery(code));
    if (normaliseRecovery(code).length === 8 && list.includes(h)) {
      db.update('users', u.id, { totp_recovery: JSON.stringify(list.filter((x) => x !== h)) });
      usedRecovery = true;
    } else {
      db.run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', c.token_hash);
      throw new HttpError(401, 'That code didn\'t work. Try the newest code from your authenticator app.');
    }
  }
  db.run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash);
  return { userId: u.id, usedRecovery, recoveryLeft: usedRecovery ? JSON.parse(userRow(u.id).totp_recovery).length : null };
}

// "Remember this device": skips the code on this browser for 30 days.
function trustDevice(userId, label) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TRUST_DAYS * 86400000).toISOString();
  db.run('DELETE FROM mfa_trusted WHERE expires_at < ?', nowIso());
  db.insert('mfa_trusted', { user_id: userId, token_hash: hash(token), expires_at: expires, label: String(label || '').slice(0, 120) });
  return { token, expires };
}
const isTrusted = (userId, token) => Boolean(token && db.one('SELECT 1 FROM mfa_trusted WHERE user_id = ? AND token_hash = ? AND expires_at > ?', userId, hash(token), nowIso()));
const forgetDevices = (userId) => db.run('DELETE FROM mfa_trusted WHERE user_id = ?', userId).changes;

function trustCookie(res, token, expires) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.append('Set-Cookie', `${TRUST_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/auth; Expires=${new Date(expires).toUTCString()}${secure}`);
}

module.exports = {
  base32, unbase32, codeAt, matchStep, stepNow, required, status, start, confirm, regenerateRecovery, disable, reset, clear, setRequired,
  challenge, verifyChallenge, trustDevice, isTrusted, forgetDevices, trustCookie, TRUST_COOKIE, newRecoveryCodes,
};
