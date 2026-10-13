'use strict';
const express = require('express');
const auth = require('../auth');
const quickli = require('../services/quickli');

// Quickli setup: the CRM's partner details and key (admin), and each
// broker's own access token.
const router = express.Router();

const status = (req) => {
  const c = quickli.config();
  return {
    configured: quickli.configured(),
    partner_id: c.partnerId,
    key_id: c.keyId,
    has_key: c.hasKey,
    public_key: req.user.role === 'admin' ? c.publicKey : undefined,
    scenario_url: c.scenarioUrl,
    token: quickli.tokenStatus(req.user.id),
  };
};

router.get('/status', (req, res) => res.json(status(req)));
router.put('/config', auth.requireRole('admin'), (req, res) => { quickli.saveConfig(req.body || {}); res.json(status(req)); });
router.post('/key', auth.requireRole('admin'), (req, res) => {
  if (req.body?.private_key) quickli.importKey(req.body.private_key);
  else quickli.generateKey();
  res.json(status(req));
});
router.put('/token', async (req, res) => res.json({ ...(await quickli.verifyToken(req.user.id, req.body?.token)), ...status(req) }));
router.post('/test', async (req, res) => res.json({ ...(await quickli.test(req.user.id)), ...status(req) }));
router.delete('/token', (req, res) => { quickli.disconnect(req.user.id); res.json(status(req)); });

module.exports = router;
