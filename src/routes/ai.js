'use strict';
const express = require('express');
const auth = require('../auth');
const loanDocsAI = require('../services/loanDocsAI');

// AI document reading (Claude): an admin adds the Anthropic API key once.
const router = express.Router();

const status = (req) => ({
  configured: loanDocsAI.configured(),
  model: loanDocsAI.model(),
  default_model: loanDocsAI.DEFAULT_MODEL,
  from_environment: Boolean(process.env.ANTHROPIC_API_KEY),
  admin: req.user.role === 'admin',
});

router.get('/status', (req, res) => res.json(status(req)));

router.put('/config', auth.requireRole('admin'), (req, res) => {
  loanDocsAI.saveConfig(req.body || {});
  res.json(status(req));
});

module.exports = router;
