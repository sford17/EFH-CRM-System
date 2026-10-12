'use strict';
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const branding = require('../services/branding');
const { buildEmail, cleanSignature } = require('../services/emailHtml');
const { render, buildContext } = require('../services/templating');
const graphics = require('../services/emailGraphics');
const parties = require('../services/parties');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

// Served without sign-in: the login page shows the logo and colours.
const publicRouter = express.Router();

publicRouter.get('/brand.css', (req, res) => {
  res.type('css').set('Cache-Control', 'no-cache').send(branding.css());
});

publicRouter.get('/assets/:id', (req, res) => {
  const asset = branding.getAsset(intParam(req.params.id));
  if (!asset) throw new HttpError(404, 'Not found');
  res.set('Content-Type', asset.mime).set('Cache-Control', 'public, max-age=86400').send(Buffer.from(asset.data));
});

const router = express.Router();

router.get('/', (req, res) => res.json(branding.getBrand()));
router.put('/', auth.requireRole('admin'), (req, res) => res.json(branding.saveBrand(req.body || {})));
router.post('/logo', auth.requireRole('admin'), (req, res) => res.json(branding.setLogo(req.body?.image)));
router.delete('/logo', auth.requireRole('admin'), (req, res) => res.json(branding.removeLogo()));

// ---- Signatures --------------------------------------------------------------
const signature = express.Router();

signature.get('/', (req, res) => {
  res.json({ html: db.one('SELECT signature_html FROM users WHERE id = ?', req.user.id).signature_html || '' });
});

signature.put('/', (req, res) => {
  const { html, removedImages } = cleanSignature(req.body?.html, req.user.id);
  db.update('users', req.user.id, { signature_html: html || null });
  res.json({ html, removed_images: removedImages });
});

signature.post('/image', (req, res) => {
  const id = branding.saveImage(req.body?.image, { kind: 'signature', userId: req.user.id, maxBytes: 512 * 1024 });
  res.status(201).json({ url: `/assets/${id}` });
});

// ---- Email previews ------------------------------------------------------------
// Rendered emails are kept briefly in memory and shown in a sandboxed iframe.
const previews = new Map();
const preview = express.Router();

// Body: { template_id } or { subject, body }, optionally with contact_id /
// deal_id / addressee_ids / recipient_role to preview for a real client.
// Without a client, example figures are used so charts can be seen.
preview.post('/', (req, res) => {
  let { subject = '', body = '' } = req.body || {};
  const { template_id: templateId, contact_id: contactId, deal_id: dealId } = req.body || {};
  const real = Boolean(contactId || dealId);
  const ctx = buildContext({
    contactId, dealId, userId: req.user.id, latestDeal: true,
    addresseeIds: req.body?.addressee_ids, recipientRole: parties.isRole(req.body?.recipient_role) ? req.body.recipient_role : null,
  });
  if (!real) Object.assign(ctx, graphics.sampleMergeData());
  if (templateId) {
    const t = db.one('SELECT * FROM email_templates WHERE id = ?', templateId);
    if (!t) throw new HttpError(404, 'Template not found');
    subject = t.subject;
    body = t.body;
  }
  if (!body) {
    body = SAMPLE_BODY;
    subject = subject || 'Sample email';
  }
  // Template text is shown filled in; text already filled in is left as is.
  if (templateId || req.body?.merge) {
    subject = render(subject, ctx);
    body = render(body, ctx);
  }
  const context = real ? { contactId: ctx.contact?.id, dealId: ctx.deal?.id, loanId: ctx.loan?.id } : { sample: true };
  const email = buildEmail({ body, senderUserId: req.user.id, preview: true, context });
  const token = crypto.randomBytes(16).toString('hex');
  previews.set(token, { html: email.html, subject, userId: req.user.id, expires: Date.now() + 10 * 60000 });
  for (const [k, v] of previews) if (v.expires < Date.now()) previews.delete(k);
  res.json({ url: `/api/email-preview/${token}`, subject, sample: !real });
});

const SAMPLE_BODY = `Hi Jane,

This is how emails from the CRM look to your clients, with your logo, colours, signature and business details.

Templates can also include charts and diagrams built from the client's details, like this loan progress tracker:

[[progress]]

[[button: Book a time | https://calendly.com]]

Kind regards,`;

preview.get('/:token', (req, res) => {
  const p = previews.get(req.params.token);
  if (!p || p.userId !== req.user.id || p.expires < Date.now()) throw new HttpError(404, 'Preview expired');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(p.html);
});

module.exports = { publicRouter, router, signature, preview };
