'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { HttpError } = require('./util');

const SESSION_DAYS = 14;
const COOKIE = 'efh_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), userId);
  return { token, expires };
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, expires) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expires).toUTCString()}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function sessionUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  return db.one(
    `SELECT u.id, u.name, u.email, u.role, u.phone, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    token, new Date().toISOString(),
  ) || null;
}

// Signed in, whether or not two-factor set-up is still owed (for the set-up screens).
function requireSession(req, res, next) {
  const user = sessionUser(req);
  if (!user) return next(new HttpError(401, 'Not signed in'));
  req.user = user;
  next();
}

// Signed in and, when the business requires it, using two-factor sign-in.
function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return next(new HttpError(401, 'Not signed in'));
  if (!user.mfa_enabled && db.getSetting('mfa_required', '0') === '1') {
    return next(new HttpError(403, 'Set up two-factor sign-in to continue', 'mfa_setup_required'));
  }
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do that'));
  next();
};

module.exports = {
  COOKIE, hashPassword, verifyPassword, createSession, readCookie, setSessionCookie,
  clearSessionCookie, sessionUser, requireAuth, requireSession, requireRole,
};
