'use strict';
const express = require('express');
const backups = require('../services/backups');

// Backups (admins only): status, settings, "back up now" and downloads.
const router = express.Router();

router.get('/', (req, res) => res.json({ settings: backups.settings(), backups: backups.list() }));
router.put('/settings', (req, res) => res.json(backups.saveSettings(req.body || {})));
router.post('/run', async (req, res) => res.status(201).json(await backups.run({ kind: 'manual', userId: req.user.id })));
router.get('/:name/:file', (req, res) => {
  const file = backups.file(String(req.params.name), String(req.params.file));
  const name = `${req.params.name}-${req.params.file}`;
  res.set('Cache-Control', 'private, no-store');
  res.download(file, name);
});

module.exports = router;
