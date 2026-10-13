'use strict';
const express = require('express');
const factFind = require('../services/factFind');
const rules = require('../../public/js/factfind/rules.js');
const { HttpError, formatDate } = require('../util');
const { intParam } = require('./helpers');

// Online fact finds and document requests.
const router = express.Router();

router.get('/', (req, res) => res.json({ rows: factFind.list({ status: String(req.query.status || ''), contactId: req.query.contact_id || null }), reachability: factFind.reachability() }));
router.get('/library', (req, res) => res.json({ documents: factFind.DOC_LIBRARY, reachability: factFind.reachability() }));
router.post('/', (req, res) => res.status(201).json(factFind.get(factFind.create(req.body || {}, req.user.id))));

// Uploaded files: shown in the browser (PDFs and pictures) or downloaded.
router.get('/files/:fileId', (req, res) => {
  const f = factFind.fileFor(intParam(req.params.fileId));
  const inline = !req.query.download && /^(application\/pdf|image\/(jpeg|png|webp))$/.test(f.mime);
  res.set('Content-Type', f.mime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(f.data));
});

router.get('/:id', (req, res) => res.json(factFind.get(intParam(req.params.id))));
router.delete('/:id', (req, res) => res.json({ ok: factFind.remove(intParam(req.params.id)) }));
router.post('/:id/send', (req, res) => {
  const id = intParam(req.params.id);
  factFind.sendLink(id, { to: req.body?.to, subject: req.body?.subject }, req.user.id);
  res.json(factFind.get(id));
});
router.post('/:id/remind', (req, res) => {
  const id = intParam(req.params.id);
  factFind.remind(id, req.user.id);
  res.json(factFind.get(id));
});
router.post('/:id/cancel', (req, res) => res.json(factFind.cancel(intParam(req.params.id), req.user.id)));
router.post('/:id/extend', (req, res) => res.json(factFind.extend(intParam(req.params.id), req.body?.days)));
router.post('/:id/reopen', (req, res) => res.json(factFind.reopen(intParam(req.params.id))));
router.post('/:id/reviewed', (req, res) => res.json(factFind.markReviewed(intParam(req.params.id))));
router.post('/:id/import', (req, res) => res.json(factFind.importToCrm(intParam(req.params.id), req.user.id)));

// The answers as a PDF, for the client file.
router.get('/:id/pdf', async (req, res) => {
  const ff = factFind.get(intParam(req.params.id));
  if (!ff.summary) throw new HttpError(400, 'Document requests have no answers to print');
  const blocks = [];
  for (const s of ff.summary) {
    blocks.push({ type: 'heading', text: s.title });
    for (const g of s.groups) {
      if (!g.rows.length) { blocks.push({ type: 'subheading', text: g.heading }); continue; }
      blocks.push({ type: 'subheading', text: g.heading }, { type: 'table', widths: [1, 1.6], columns: ['', ''], align: ['left', 'left'], rows: g.rows });
    }
  }
  const docs = ff.documents.map((d) => [d.label + (d.who ? ` (${d.who})` : ''), d.files.length ? `${d.files.length} file${d.files.length === 1 ? '' : 's'} received` : d.optional ? 'Optional' : 'Not received']);
  blocks.push({ type: 'heading', text: 'Documents' }, { type: 'table', widths: [2, 1], columns: ['Document', 'Status'], align: ['left', 'left'], rows: docs });
  const d = ff.answers.declaration;
  blocks.push({ type: 'note', text: ff.submitted_at ? `Submitted online ${formatDate(ff.submitted_at.slice(0, 10))}${d.signature ? ` and signed "${d.signature}"` : ''}. The client agreed to the privacy consent and declared the information true and correct.` : 'Not yet submitted by the client.' });
  const owner = require('../db').one('SELECT u.name, u.email, u.phone FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', ff.contact.id) || {};
  const pdf = await require('../services/review').renderPdf({
    title: 'Fact find', prepared_for: [ff.contact.first_name, ff.contact.last_name].filter(Boolean).join(' '), date: formatDate(new Date().toISOString().slice(0, 10)), broker: owner,
    business: { name: require('../db').getSetting('business_name', ''), acl: require('../db').getSetting('acl_number', '') }, blocks,
  });
  const name = `Fact find – ${[ff.contact.first_name, ff.contact.last_name].filter(Boolean).join(' ')}.pdf`;
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(pdf);
});

// ---- The client's private link (no sign-in) ---------------------------------------------------------
const publicRouter = express.Router();
publicRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
publicRouter.get('/:token', (req, res) => res.json(factFind.publicView(factFind.byToken(req.params.token))));
publicRouter.put('/:token', (req, res) => res.json(factFind.publicSave(factFind.byToken(req.params.token), req.body || {})));
publicRouter.post('/:token/submit', (req, res) => res.json(factFind.publicSubmit(factFind.byToken(req.params.token), req.body || {})));
publicRouter.post('/:token/files', (req, res) => res.status(201).json(factFind.publicUpload(factFind.byToken(req.params.token), req.body || {})));
publicRouter.delete('/:token/files/:fileId', (req, res) => res.json(factFind.publicDeleteFile(factFind.byToken(req.params.token), intParam(req.params.fileId))));

module.exports = { router, publicRouter, rules };
