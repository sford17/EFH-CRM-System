'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const newsletter = require('../services/newsletter');
const ai = require('../services/loanDocsAI');
const { buildEmail } = require('../services/emailHtml');
const { HttpError } = require('../util');
const { intParam, notFound } = require('./helpers');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Without sign-in: the unsubscribe link in each newsletter.
const publicRouter = express.Router();
publicRouter.get('/unsubscribe', (req, res) => {
  const ok = newsletter.unsubscribe(req.query.c, String(req.query.t || ''));
  const business = db.getSetting('business_name', '') || 'us';
  const title = ok ? 'You\'re unsubscribed' : 'That link didn\'t work';
  const message = ok ? `You won't receive any more newsletters or marketing emails from ${business}. You'll still hear from us about any loans we're helping you with.`
    : `Please reply to the newsletter email and ask to be unsubscribed, and ${business} will take care of it.`;
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css"></head><body><div class="auth-wrap"><div class="auth-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></div></body></html>`);
});

const router = express.Router();

const load = (id) => notFound(newsletter.get(intParam(id)), 'Newsletter');

router.get('/', (req, res) => {
  res.json({
    rows: newsletter.list(),
    settings: newsletter.settings(),
    ai_configured: ai.configured(),
    recipients_count: newsletter.recipients().length,
    current_month: newsletter.currentMonth(),
    current_month_label: newsletter.monthLabel(newsletter.currentMonth()),
    users: req.user.role === 'admin' ? db.all('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name') : undefined,
  });
});

router.put('/settings', auth.requireRole('admin'), (req, res) => res.json(newsletter.saveSettings(req.body || {})));

router.get('/recipients', (req, res) => {
  const rows = newsletter.recipients().map((r) => ({
    id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' '), email: r.email, status: r.status,
    loans: db.one("SELECT COUNT(*) AS n FROM loans WHERE (contact_id = ? OR co_borrower_id = ?) AND status = 'active' AND interest_rate > 0", r.id, r.id).n,
  }));
  res.json({ rows });
});

router.post('/generate', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.body?.month || '')) ? req.body.month : newsletter.currentMonth();
  const { id } = newsletter.generate(month, { userId: req.user.id, regenerate: Boolean(req.body?.regenerate) });
  res.status(202).json(newsletter.get(id));
});

router.get('/:id', (req, res) => {
  const n = load(req.params.id);
  res.json({ ...n, stats: newsletter.stats(n.id), recipients_count: newsletter.recipients().length, booking_ready: newsletter.settings().booking_ready });
});

router.put('/:id', (req, res) => res.json(newsletter.save(load(req.params.id).id, req.body?.content, req.user.id)));

router.delete('/:id', (req, res) => {
  const n = load(req.params.id);
  if (n.status === 'sent') throw new HttpError(400, 'Sent newsletters are kept as a record');
  if (n.status === 'generating') throw new HttpError(400, 'Wait for the newsletter to finish being written');
  db.run('DELETE FROM newsletters WHERE id = ?', n.id);
  res.json({ ok: true });
});

// The email as a client sees it (`contact_id`), or with example figures.
router.get('/:id/preview', (req, res) => {
  const row = db.one('SELECT * FROM newsletters WHERE id = ?', intParam(req.params.id));
  if (!row?.content) throw new HttpError(404, 'Nothing to preview yet');
  const contact = req.query.contact_id ? db.one('SELECT id, first_name, last_name, email, owner_id FROM contacts WHERE id = ?', Number(req.query.contact_id)) : null;
  const r = newsletter.render(row, JSON.parse(row.content), contact, { senderId: req.user.id });
  const email = buildEmail({ body: r.text, htmlBody: r.html, senderUserId: contact?.owner_id || req.user.id, preview: true });
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(email.html);
});

router.post('/:id/test', async (req, res) => {
  const n = load(req.params.id);
  const user = db.one('SELECT id, name, email FROM users WHERE id = ?', req.user.id);
  if (!user.email) throw new HttpError(400, 'Add your email address to your user profile first');
  const r = newsletter.sendTest(n.id, user);
  await require('../services/mailer').processOutbox();
  const out = db.one('SELECT status, error FROM outbox WHERE id = ?', r.outboxId);
  if (out.status === 'failed') throw new HttpError(502, `The test couldn't be sent: ${out.error}`);
  res.json({ to: user.email, status: out.status, sample: r.sample });
});

router.post('/:id/send', (req, res) => {
  const n = load(req.params.id);
  res.json(newsletter.send(n.id, req.user.id, { exclude: req.body?.exclude || [] }));
});

module.exports = { router, publicRouter };
