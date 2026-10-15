'use strict';
// Welcome emails for new team members: a one-time link to choose their own
// password (so nobody has to send a password by email or text). The same link,
// with different wording, resets the password of someone who has forgotten it.
const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../auth');
const mfa = require('./mfa');
const { nowIso, HttpError } = require('../util');

const DAYS = { welcome: 7, reset: 1 };
const hash = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

// The CRM's web address for the link: Settings → Business, else the address in use.
function baseUrl(requestBase) {
  return (process.env.APP_URL || db.getSetting('app_url', '') || requestBase || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

const expiryText = (iso) => new Intl.DateTimeFormat('en-AU', {
  weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: process.env.TZ_BUSINESS || 'Australia/Sydney',
}).format(new Date(iso));

function emailFor({ kind, user, sender, link, expires, base }) {
  const business = db.getSetting('business_name', '') || 'our';
  const first = user.name.split(/\s+/)[0];
  if (kind === 'reset') {
    return {
      subject: `Choose a new password for the ${business} CRM`,
      body: [
        `Hi ${first},`,
        `${sender.name} has sent you a link to choose a new password for the ${business} CRM.`,
        `[[button: Choose a new password | ${link}]]`,
        `The link works once and expires ${expiryText(expires)}. Your two-factor sign-in stays the same, so have your phone handy.`,
        `If you weren't expecting this, let ${sender.name} know.`,
      ].join('\n\n'),
    };
  }
  const steps = [
    '- Choose your password with the button above.',
    mfa.required()
      ? '- Set up two-factor sign-in when asked: you\'ll need Microsoft Authenticator or Google Authenticator (free) on your phone, and the CRM shows you each step.'
      : '- Set up two-factor sign-in under Settings → Two-factor sign-in, with Microsoft Authenticator or Google Authenticator (free) on your phone.',
    '- Connect your Outlook under Settings → Outlook email → Connect Outlook, so client emails are filed for you and emails you send from the CRM come from your own mailbox.',
    user.role !== 'assistant' ? '- Add your mobile under Settings → SMS → My mobile number, so texts to your clients come from you.' : null,
  ].filter(Boolean);
  return {
    subject: `Welcome to the ${business} CRM`,
    body: [
      `Hi ${first},`,
      `${sender.name} has set up your account on the ${business} CRM.`,
      `[[button: Choose your password | ${link}]]`,
      `The link works once and expires ${expiryText(expires)}. After that, sign in any time at ${base} with your email address (${user.email}).`,
      '## Getting started',
      steps.join('\n'),
    ].join('\n\n'),
  };
}

// Emails the person a one-time link. Earlier unused links stop working.
// Returns { kind, status, expires_at, link }; the link is only for the admin to copy if the email can't be sent.
async function send(userId, byUserId, requestBase) {
  const user = db.one('SELECT id, name, email, role, active, last_login_at FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'User not found');
  if (!user.active) throw new HttpError(400, `${user.name} is inactive. Tick Active first.`);
  const sender = db.one('SELECT id, name FROM users WHERE id = ?', byUserId);
  const kind = user.last_login_at ? 'reset' : 'welcome';
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + DAYS[kind] * 86400000).toISOString();
  db.run('DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL', user.id);
  db.insert('user_invites', { token_hash: hash(token), user_id: user.id, kind, created_by: byUserId, expires_at: expires });

  const base = baseUrl(requestBase);
  const link = `${base}/#/welcome/${token}`;
  const mail = emailFor({ kind, user, sender, link, expires, base });
  const mailer = require('./mailer');
  const outboxId = mailer.queueEmail({ to: user.email, subject: mail.subject, body: mail.body, senderUserId: byUserId });
  await mailer.processOutbox();
  // Anyone can see the Outbox, so the link doesn't stay there.
  db.run('UPDATE outbox SET body = replace(body, ?, ?) WHERE id = ?', link, `${base}/#/welcome/(one-time link, removed after sending)`, outboxId);
  const row = db.one('SELECT status, error FROM outbox WHERE id = ?', outboxId);
  db.insert('activities', { user_id: byUserId, type: 'system', body: `${kind === 'welcome' ? 'Welcome email' : 'Password link'} ${row.status === 'sent' ? 'sent' : 'prepared'} for ${user.name}` });
  return { kind, status: row.status, error: row.error, expires_at: expires, link: row.status === 'sent' ? null : link, to: user.email };
}

function findValid(token) {
  const invite = db.one('SELECT * FROM user_invites WHERE token_hash = ?', hash(token));
  if (!invite || invite.used_at || invite.expires_at < nowIso()) {
    throw new HttpError(410, 'This link has expired or has already been used. Ask your administrator to send a new one.');
  }
  const user = db.one('SELECT id, name, email, role, active, totp_enabled_at FROM users WHERE id = ?', invite.user_id);
  if (!user?.active) throw new HttpError(410, 'This account is no longer active.');
  return { invite, user };
}

// What the "choose your password" page shows.
function describe(token) {
  const { invite, user } = findValid(token);
  return { kind: invite.kind, name: user.name, email: user.email, mfa_required: mfa.required(), has_mfa: Boolean(user.totp_enabled_at) };
}

// Sets the password and uses up the link. Returns the user (to sign in) and
// whether a code from their authenticator app is still needed.
function accept(token, password) {
  const { invite, user } = findValid(token);
  if (String(password || '').length < 8) throw new HttpError(400, 'Choose a password of at least 8 characters');
  db.update('users', user.id, { password_hash: auth.hashPassword(password) });
  db.run('UPDATE user_invites SET used_at = ? WHERE token_hash = ?', nowIso(), invite.token_hash);
  db.run('DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL', user.id);
  db.run('DELETE FROM sessions WHERE user_id = ?', user.id); // signed out everywhere else
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, needsCode: Boolean(user.totp_enabled_at) };
}

// A password nobody knows, for accounts that will choose their own from the welcome email.
const unusablePassword = () => auth.hashPassword(crypto.randomBytes(32).toString('hex'));

module.exports = { send, describe, accept, unusablePassword, emailFor, baseUrl };
