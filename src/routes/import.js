'use strict';
const express = require('express');
const db = require('../db');
const importer = require('../services/importer');
const { HttpError } = require('../util');
const { intParam } = require('./helpers');

const router = express.Router();

router.get('/fields', (req, res) => {
  res.json({ fields: importer.FIELDS.map(({ key, label, group }) => ({ key, label, group })) });
});

router.get('/template.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="client-import-template.csv"');
  res.send(importer.templateCsv());
});

// Body: { filename, data: <base64 file> }. Returns every sheet with its
// header row, data rows and a guessed column mapping.
router.post('/parse', async (req, res) => {
  const { filename = '', data } = req.body || {};
  if (!data) throw new HttpError(400, 'Choose a file to upload');
  const buffer = Buffer.from(String(data), 'base64');
  res.json({ filename, sheets: await importer.readWorkbook(buffer, filename) });
});

const PREVIEW_ROWS = 300;

router.post('/preview', (req, res) => {
  const { records, summary } = importer.processRows(req.body || {});
  // Rows with problems first, so they're easy to review.
  const flagged = records.filter((r) => r.errors.length || r.warnings.length);
  const clean = records.filter((r) => !r.errors.length && !r.warnings.length);
  res.json({ summary, records: [...flagged, ...clean].slice(0, PREVIEW_ROWS) });
});

router.post('/commit', (req, res) => {
  res.json(importer.commit(req.body || {}, req.user.id));
});

router.get('/history', (req, res) => {
  res.json({
    rows: db.all(
      `SELECT i.*, u.name AS user_name FROM imports i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.id DESC LIMIT 50`,
    ),
  });
});

router.post('/:id/undo', (req, res) => {
  res.json(importer.undo(intParam(req.params.id), req.user));
});

module.exports = router;
