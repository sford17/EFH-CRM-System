'use strict';
// Adobe Acrobat Sign: connection (admin) and documents sent for signature.
const express = require('express');
const auth = require('../auth');
const adobe = require('../services/adobeSign');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

const router = express.Router();

// Adobe errors become 502s so a rejected key never looks like the CRM session expiring.
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err.message);
  }
};

router.get('/status', (req, res) => res.json(adobe.status()));
router.post('/connect', auth.requireRole('admin'), wrap(async (req, res) => res.json(await adobe.connect(req.body?.key))));
router.post('/disconnect', auth.requireRole('admin'), (req, res) => { adobe.disconnect(); res.json(adobe.status()); });
router.put('/settings', auth.requireRole('admin'), (req, res) => res.json(adobe.setSendAsUser(Boolean(req.body?.send_as_user))));

router.get('/requests', (req, res) => {
  res.json({ rows: adobe.list({ contactId: Number(req.query.contact_id) || null, dealId: Number(req.query.deal_id) || null }) });
});
router.post('/requests', wrap(async (req, res) => res.status(201).json(await adobe.send(req.body || {}, req.user))));
router.post('/requests/:id/refresh', wrap(async (req, res) => res.json(await adobe.refresh(intParam(req.params.id)))));
router.post('/requests/:id/remind', wrap(async (req, res) => res.json(await adobe.remind(intParam(req.params.id), req.body?.note))));
router.post('/requests/:id/cancel', wrap(async (req, res) => res.json(await adobe.cancel(intParam(req.params.id), req.body?.reason, req.user))));
router.get('/requests/:id/signed.pdf', (req, res) => {
  const f = adobe.signedPdf(intParam(req.params.id));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${f.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(f.data);
});

module.exports = router;
