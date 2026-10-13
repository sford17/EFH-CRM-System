'use strict';
const express = require('express');
const backups = require('../services/backups');

// Backups (admins only): status, settings, "back up now" and downloads.
const router = express.Router();

router.get('/', (req, res) => res.json({ settings: backups.settings(), backups: backups.list() }));
router.put('/settings', (req, res) => res.json(backups.saveSettings(req.body || {})));
router.post('/run', async (req, res) => res.status(201).json(await backups.run({ kind: 'manual', userId: req.user.id })));
// Restoring: upload crm.db (and secret.key) as raw files, then apply.
router.put('/restore/:file', async (req, res) => res.json(await backups.stage(String(req.params.file), req)));
router.delete('/restore', (req, res) => { backups.discardStaged(); res.json({ ok: true }); });
router.post('/restore/apply', async (req, res) => res.json(await backups.restore(req.user.id)));
router.get('/:name/:file', (req, res) => {
  const file = backups.file(String(req.params.name), String(req.params.file));
  const name = `${req.params.name}-${req.params.file}`;
  res.set('Cache-Control', 'private, no-store');
  res.download(file, name);
});

module.exports = router;
