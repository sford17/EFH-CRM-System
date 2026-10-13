'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const pn = require('../services/partnerNewsletter');
const ai = require('../services/loanDocsAI');
const { buildEmail } = require('../services/emailHtml');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Without sign-in: the unsubscribe link in each partner newsletter.
const publicRouter = express.Router();
publicRouter.get('/partner-unsubscribe', (req, res) => {
  const ok = pn.unsubscribe(req.query.p, String(req.query.t || ''));
  const business = db.getSetting('business_name', '') || 'us';
  const title = ok ? 'You\'re unsubscribed' : 'That link didn\'t work';
  const message = ok ? `You won't receive the partner newsletter from ${business} any more.` : `Please reply to the newsletter email and ask to be unsubscribed, and ${business} will take care of it.`;
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css"></head><body><div class="auth-wrap"><div class="auth-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></div></body></html>`);
});

const router = express.Router();
const monthParam = (m) => (/^\d{4}-\d{2}$/.test(String(m || '')) ? m : require('../services/newsletter').currentMonth());
const load = (id) => {
  const n = pn.get(intParam(id));
  if (!n) throw new HttpError(404, 'Newsletter not found');
  return n;
};

router.get('/', (req, res) => {
  const { monthLabel, currentMonth } = require('../services/newsletter');
  res.json({
    rows: pn.list(), settings: pn.settings(), ai_configured: ai.configured(), recipients_count: pn.recipients().length,
    current_month: currentMonth(), current_month_label: monthLabel(currentMonth()),
    types: pn.PARTNER_TYPES.map((t) => [t, pn.TYPE_LABELS[t]]),
    users: req.user.role === 'admin' ? db.all('SELECT id, name, email, role FROM users WHERE active = 1 ORDER BY name') : undefined,
  });
});
router.put('/settings', auth.requireRole('admin'), (req, res) => res.json(pn.saveSettings(req.body || {})));
router.get('/recipients', (req, res) => res.json({ rows: pn.recipients().map((p) => ({ id: p.id, name: p.name, company: p.company, email: p.email, type: pn.TYPE_LABELS[p.type] || p.type })) }));
router.get('/ideas', (req, res) => res.json({ rows: pn.ideas() }));
router.post('/draft', (req, res) => res.status(201).json(pn.draft(monthParam(req.body?.month))));
router.post('/generate', (req, res) => {
  const { id } = pn.generate(monthParam(req.body?.month), { regenerate: Boolean(req.body?.regenerate) });
  res.status(202).json(pn.get(id));
});
router.post('/polish', async (req, res) => res.json(await pn.polishScenario(req.body?.notes)));

router.get('/:id', (req, res) => {
  const n = load(req.params.id);
  res.json({ ...n, stats: pn.stats(n.id), recipients_count: pn.recipients().length, missing: n.content ? pn.missing(pn.clean(n.content, n.month)) : null });
});
router.put('/:id/notes', (req, res) => res.json(pn.saveNotes(load(req.params.id).id, req.body?.notes, req.user.id)));
router.put('/:id', (req, res) => res.json(pn.save(load(req.params.id).id, req.body?.content, req.user.id)));
router.delete('/:id', (req, res) => res.json({ ok: pn.remove(load(req.params.id).id) }));

router.get('/:id/preview', (req, res) => {
  const n = load(req.params.id);
  if (!n.content) throw new HttpError(404, 'Nothing to preview yet');
  const partner = req.query.partner_id ? db.one('SELECT id, name, email FROM referral_partners WHERE id = ?', Number(req.query.partner_id)) : { id: null, name: 'Sarah Example' };
  const sender = db.one('SELECT id, name, email, phone FROM users WHERE id = ?', req.user.id);
  const r = pn.render(n, pn.clean(n.content, n.month), partner, { sender });
  const email = buildEmail({ body: r.text, htmlBody: r.html, senderUserId: req.user.id, preview: true });
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(email.html);
});

router.post('/:id/test', async (req, res) => {
  const n = load(req.params.id);
  const user = db.one('SELECT id, name, email FROM users WHERE id = ?', req.user.id);
  if (!user.email) throw new HttpError(400, 'Add your email address to your user profile first');
  const outboxId = pn.sendTest(n.id, user);
  await require('../services/mailer').processOutbox();
  const out = db.one('SELECT status, error FROM outbox WHERE id = ?', outboxId);
  if (out.status === 'failed') throw new HttpError(502, `The test couldn't be sent: ${out.error}`);
  res.json({ to: user.email, status: out.status });
});
router.post('/:id/send', (req, res) => res.json(pn.send(load(req.params.id).id, req.user.id, { exclude: req.body?.exclude || [] })));

module.exports = { router, publicRouter };
