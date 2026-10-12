'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const outlook = require('../services/outlook');
const { HttpError } = require('../util');
const { notFound, intParam, like } = require('./helpers');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Microsoft redirects the browser here after sign-in. Session cookies are
// SameSite=Strict, so they are not sent on this cross-site redirect; the
// one-time `state` value identifies the user instead.
const publicRouter = express.Router();
publicRouter.get('/callback', async (req, res) => {
  let title = 'Outlook connected';
  let message = 'Your mailbox is connected. Emails with your clients will start appearing in the CRM within a few minutes.';
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    const { email } = await outlook.finishConnect({ code: req.query.code, state: req.query.state });
    message = `${email} is connected. ${message.split('. ')[1]}`;
  } catch (err) {
    title = 'Outlook could not be connected';
    message = err.message;
  }
  // A same-site page navigation brings the session cookie back.
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="4;url=/#/settings"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css"></head><body><div class="auth-wrap"><div class="auth-card">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/#/settings">Back to the CRM</a>
</div></div></body></html>`);
});

const router = express.Router();

router.get('/status', (req, res) => {
  const cfg = outlook.appConfig();
  res.json({
    configured: outlook.isConfigured(),
    app: req.user.role === 'admin'
      ? { client_id: cfg.clientId, tenant: cfg.tenant === 'common' ? '' : cfg.tenant, has_secret: Boolean(cfg.clientSecret) }
      : undefined,
    account: outlook.publicAccount(db.one('SELECT * FROM mail_accounts WHERE user_id = ?', req.user.id)),
    team: db.all(
      `SELECT u.name, a.email, a.connected, a.last_sync_at, a.sync_error FROM mail_accounts a JOIN users u ON u.id = a.user_id ORDER BY u.name`,
    ),
  });
});

router.put('/config', auth.requireRole('admin'), (req, res) => {
  outlook.saveAppConfig(req.body || {});
  res.json({ configured: outlook.isConfigured() });
});

router.post('/connect', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/api/outlook/callback`;
  res.json({ url: outlook.startConnect(req.user.id, redirectUri) });
});

router.post('/sync', async (req, res) => {
  const account = outlook.accountForUser(req.user.id);
  if (!account) throw new HttpError(400, 'Connect your Outlook first');
  try {
    res.json(await outlook.syncAccount(account.id));
  } catch (err) {
    throw new HttpError(502, err.message);
  }
});

router.post('/disconnect', (req, res) => {
  outlook.disconnect(req.user.id);
  res.json({ ok: true });
});

// ---- Synced emails -----------------------------------------------------------
const emails = express.Router();

const LIST_SQL = `
  SELECT e.id, e.direction, e.from_email, e.from_name, e.to_emails, e.subject, e.preview, e.sent_at,
         e.has_attachments, e.deal_id, u.name AS mailbox_owner,
         (SELECT GROUP_CONCAT(c.first_name || ' ' || COALESCE(c.last_name,''), ', ') FROM email_contacts ec
            JOIN contacts c ON c.id = ec.contact_id WHERE ec.email_id = e.id) AS contact_names,
         (SELECT MIN(ec.contact_id) FROM email_contacts ec WHERE ec.email_id = e.id) AS contact_id,
         e.lender_id, (SELECT name FROM lenders WHERE id = e.lender_id) AS lender_name
  FROM emails e JOIN mail_accounts a ON a.id = e.account_id JOIN users u ON u.id = a.user_id`;

function listEmails({ contactIds, dealId, lenderId, direction, q, limit = 50 }) {
  const where = [];
  const params = [];
  if (lenderId) { where.push('e.lender_id = ?'); params.push(lenderId); }
  if (contactIds) {
    where.push(`e.id IN (SELECT email_id FROM email_contacts WHERE contact_id IN (${contactIds.map(() => '?').join(',')}))`);
    params.push(...contactIds);
  }
  if (dealId) { where.push('e.deal_id = ?'); params.push(dealId); }
  if (direction) { where.push('e.direction = ?'); params.push(direction); }
  if (q) {
    where.push(`(e.subject LIKE ? ESCAPE '\\' OR e.body_text LIKE ? ESCAPE '\\' OR e.from_email LIKE ? ESCAPE '\\' OR e.to_emails LIKE ? ESCAPE '\\')`);
    params.push(like(q), like(q), like(q), like(q));
  }
  return db.all(`${LIST_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.sent_at DESC LIMIT ?`, ...params, limit);
}

emails.get('/', (req, res) => {
  res.json({
    rows: listEmails({
      contactIds: req.query.contact_id ? [Number(req.query.contact_id)] : null,
      dealId: req.query.deal_id ? Number(req.query.deal_id) : null,
      direction: ['in', 'out'].includes(req.query.direction) ? req.query.direction : null,
      q: req.query.q || null,
      limit: Math.min(Number(req.query.limit) || 100, 500),
    }),
  });
});

emails.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const email = notFound(db.one(
    `SELECT e.*, a.user_id AS mailbox_user_id, a.connected AS mailbox_connected, u.name AS mailbox_owner
     FROM emails e JOIN mail_accounts a ON a.id = e.account_id JOIN users u ON u.id = a.user_id WHERE e.id = ?`,
    id,
  ), 'Email');
  email.contacts = db.all(
    'SELECT c.id, c.first_name, c.last_name, c.email FROM email_contacts ec JOIN contacts c ON c.id = ec.contact_id WHERE ec.email_id = ?',
    id,
  );
  email.lender = email.lender_id ? db.one('SELECT id, name FROM lenders WHERE id = ?', email.lender_id) : null;
  email.can_reply = email.mailbox_user_id === req.user.id && Boolean(email.mailbox_connected);
  delete email.graph_id;
  res.json(email);
});

emails.post('/:id/reply', async (req, res) => {
  try {
    res.json(await outlook.reply(intParam(req.params.id), req.user.id, req.body?.body));
  } catch (err) {
    if (err.status) throw err;
    throw new HttpError(502, err.message);
  }
});

module.exports = { publicRouter, router, emails, listEmails };
