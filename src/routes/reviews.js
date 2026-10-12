'use strict';
const express = require('express');
const db = require('../db');
const review = require('../services/review');
const mailer = require('../services/mailer');
const { today, addMonths, nowIso, HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const router = express.Router();
const TEXT_FIELDS = ['title', 'review_date', 'loan_review', 'actions_to_consider', 'broker_to_action', 'next_steps'];
const household = require('../services/household');

const load = (id) => notFound(db.one('SELECT * FROM reviews WHERE id = ?', intParam(id)), 'Review');
const withoutSnapshot = ({ snapshot, ...r }) => r;

router.get('/', (req, res) => {
  const contactId = Number(req.query.contact_id) || null;
  res.json({
    rows: db.all(
      `SELECT r.id, r.contact_id, r.title, r.review_date, r.status, r.sent_at, r.sent_to, r.created_at, r.updated_at, u.name AS created_by_name,
              c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
       FROM reviews r LEFT JOIN users u ON u.id = r.created_by JOIN contacts c ON c.id = r.contact_id
       ${contactId ? 'WHERE r.contact_id = ?' : ''} ORDER BY r.review_date DESC, r.id DESC LIMIT 200`,
      ...(contactId ? [contactId] : []),
    ),
  });
});

// New review: snapshot the tracker and pre-fill commentary suggestions.
router.post('/', (req, res) => {
  const contactId = Number(req.body?.contact_id);
  notFound(db.one('SELECT 1 FROM contacts WHERE id = ?', contactId), 'Contact');
  const snap = review.snapshot(contactId, req.user.id);
  const date = today();
  const id = db.insert('reviews', {
    contact_id: contactId,
    title: 'Client Lending Review',
    review_date: date,
    snapshot: JSON.stringify(snap),
    // Couples sharing finances get one review addressed to both.
    addressee_ids: JSON.stringify(snap.household.map((m) => m.id)),
    created_by: req.user.id,
    ...review.suggestions(snap, date),
  });
  db.insert('activities', { contact_id: contactId, user_id: req.user.id, type: 'system', body: 'Lending review started' });
  res.status(201).json(withoutSnapshot(db.one('SELECT * FROM reviews WHERE id = ?', id)));
});

router.get('/:id', (req, res) => {
  const r = load(req.params.id);
  const snap = JSON.parse(r.snapshot);
  res.json({
    ...withoutSnapshot(r), snapshot_taken_at: snap.taken_at, contact: snap.contact, totals: snap.totals, suggestions: review.suggestions(snap, r.review_date),
    household: household.household(r.contact_id), addressees: review.addressees(r), prepared_for: household.jointName(review.addressees(r)),
  });
});

router.patch('/:id', (req, res) => {
  const r = load(req.params.id);
  const row = pick(req.body, TEXT_FIELDS);
  if (req.body?.addressee_ids !== undefined) {
    const allowed = new Set(household.householdIds(r.contact_id));
    const ids = [...new Set((Array.isArray(req.body.addressee_ids) ? req.body.addressee_ids : []).map(Number))].filter((x) => allowed.has(x));
    if (!ids.length) throw new HttpError(400, 'Address the review to at least one person');
    row.addressee_ids = JSON.stringify(ids);
  }
  if (row.title === null) throw new HttpError(400, 'Give the review a title');
  if (row.review_date === null) throw new HttpError(400, 'Choose a review date');
  db.update('reviews', r.id, { ...row, updated_at: nowIso() });
  res.json(withoutSnapshot(db.one('SELECT * FROM reviews WHERE id = ?', r.id)));
});

// Re-read the tracker (e.g. after updating a valuation); commentary is kept.
router.post('/:id/refresh', (req, res) => {
  const r = load(req.params.id);
  db.update('reviews', r.id, { snapshot: JSON.stringify(review.snapshot(r.contact_id, req.user.id)), updated_at: nowIso() });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const r = load(req.params.id);
  db.run('DELETE FROM reviews WHERE id = ?', r.id);
  res.json({ ok: true });
});

router.get('/:id/preview', (req, res) => {
  const html = review.renderHtml(review.model(load(req.params.id)));
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(html);
});

const download = (res, filename, mime, buf) => {
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
};

router.get('/:id/pdf', async (req, res) => {
  const r = load(req.params.id);
  download(res, review.fileName(r, 'pdf'), 'application/pdf', await review.renderPdf(review.model(r)));
});

router.get('/:id/docx', async (req, res) => {
  const r = load(req.params.id);
  download(res, review.fileName(r, 'docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', await review.renderDocx(review.model(r)));
});

// Email the review as a PDF attachment from the broker's mailbox.
router.post('/:id/email', async (req, res) => {
  const r = load(req.params.id);
  const snap = JSON.parse(r.snapshot);
  const body = pick(req.body, ['to', 'subject', 'body']);
  requireFields(body, ['to', 'subject', 'body']);
  const pdf = await review.renderPdf(review.model(r));
  const outboxId = mailer.queueEmail({
    to: body.to,
    subject: body.subject,
    body: body.body,
    contactId: r.contact_id,
    senderUserId: req.user.id,
    attachments: [{ filename: review.fileName(r, 'pdf'), mime: 'application/pdf', data: pdf }],
  });
  await mailer.processOutbox();
  const sent = db.one('SELECT id, status, sent_via, error FROM outbox WHERE id = ?', outboxId);
  if (sent.status === 'failed') throw new HttpError(502, `The email couldn't be sent: ${sent.error}`);
  db.update('reviews', r.id, { status: 'sent', sent_at: nowIso(), sent_to: body.to, updated_at: nowIso() });
  // Logged on everyone it was addressed to, and their next annual review pencilled in.
  for (const person of review.addressees(r)) {
    db.insert('activities', { contact_id: person.id, user_id: req.user.id, type: 'system', body: `Lending review emailed to ${body.to}` });
    const contact = db.one('SELECT next_review_date FROM contacts WHERE id = ?', person.id);
    if (!contact.next_review_date || contact.next_review_date <= today()) {
      db.update('contacts', person.id, { next_review_date: addMonths(r.review_date, 12) });
    }
  }
  res.json({ ...sent, contact: snap.contact.full_name });
});

module.exports = router;
