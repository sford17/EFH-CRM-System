'use strict';
const express = require('express');
const leads = require('../services/leadGenerator');
const ai = require('../services/loanDocsAI');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

// Lead generator: AI web searches for potential leads, reviewed by the broker.
const router = express.Router();

router.get('/searches', (req, res) => res.json({ configured: ai.configured(), rows: leads.list(req.user.id), lead_types: leads.LEAD_TYPES }));
router.post('/searches', (req, res) => {
  const { id } = leads.start(req.user.id, req.body || {});
  res.status(202).json(leads.get(id, req.user.id));
});
router.get('/searches/:id', (req, res) => res.json(leads.get(intParam(req.params.id), req.user.id)));
router.delete('/searches/:id', (req, res) => res.json({ ok: leads.remove(intParam(req.params.id), req.user.id) }));
router.post('/searches/:id/leads/:leadId/add', (req, res) => {
  const as = req.body?.as === 'partner' ? 'partner' : req.body?.as === 'lead' ? 'lead' : null;
  if (!as) throw new HttpError(400, 'Add as a lead or a referral partner');
  res.json(leads.add(intParam(req.params.id), req.user.id, intParam(req.params.leadId), as));
});
router.post('/searches/:id/leads/:leadId/dismiss', (req, res) => {
  res.json(leads.dismiss(intParam(req.params.id), req.user.id, intParam(req.params.leadId), Boolean(req.body?.undo)));
});

module.exports = router;
