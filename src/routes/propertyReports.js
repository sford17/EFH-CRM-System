'use strict';
const express = require('express');
const reports = require('../services/propertyReport');
const ai = require('../services/loanDocsAI');
const review = require('../services/review');
const { buildEmail } = require('../services/emailHtml');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

// Property reports: a client's valuation history plus AI-researched area data.
const router = express.Router();

const PREVIEW_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
const framed = (res, html) => {
  res.set('Content-Security-Policy', PREVIEW_CSP);
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(html);
};
const ready = (id) => {
  const r = reports.get(id);
  if (!r.content) throw new HttpError(404, 'Nothing to show yet');
  return r;
};

router.get('/contact/:contactId', (req, res) => {
  const contactId = intParam(req.params.contactId);
  res.json({ configured: ai.configured(), rows: reports.listFor(contactId), properties: reports.candidates(contactId) });
});

router.post('/', (req, res) => {
  const { id } = reports.create(intParam(req.body?.contact_id), req.body?.property_ids, req.user.id);
  res.status(202).json(reports.get(id));
});

router.get('/:id', (req, res) => res.json(reports.get(intParam(req.params.id))));
router.put('/:id', (req, res) => res.json(reports.save(intParam(req.params.id), req.body?.content)));
router.delete('/:id', (req, res) => res.json({ ok: reports.remove(intParam(req.params.id)) }));

router.post('/:id/refresh', (req, res) => {
  const id = intParam(req.params.id);
  reports.refreshAreas(id);
  res.status(202).json(reports.get(id));
});

router.get('/:id/preview', (req, res) => framed(res, review.renderHtml(reports.model(ready(intParam(req.params.id))))));

router.get('/:id/email-preview', (req, res) => {
  const r = ready(intParam(req.params.id));
  const contact = require('../db').one('SELECT owner_id FROM contacts WHERE id = ?', r.contact_id);
  const body = reports.emailHtml(r, contact?.owner_id || req.user.id);
  framed(res, buildEmail({ body: body.text, htmlBody: body.html, senderUserId: contact?.owner_id || req.user.id, preview: true }).html);
});

router.get('/:id/pdf', async (req, res) => {
  const r = ready(intParam(req.params.id));
  const pdf = await review.renderPdf(reports.model(r));
  const name = reports.fileName(r);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(pdf);
});

router.post('/:id/email', async (req, res) => {
  const r = await reports.send(intParam(req.params.id), { to: req.body?.to, subject: req.body?.subject }, req.user.id);
  res.json({ ...r.report, outbox: { id: r.outbox.id, status: r.outbox.status } });
});

module.exports = router;
