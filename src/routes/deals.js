'use strict';
const express = require('express');
const db = require('../db');
const automation = require('../services/automation');
const documents = require('../services/documents');
const mailer = require('../services/mailer');
const { listEmails } = require('./outlook');
const commissions = require('../services/commissions');
const parties = require('../services/parties');
const { lvr } = require('../services/templating');
const { STAGES, STAGE_KEYS, LOAN_TYPE_KEYS, loanTypeForPurpose } = require('../constants');
const { nowIso, HttpError } = require('../util');
const { pick, requireFields, notFound, intParam, like, safeLink } = require('./helpers');

const borrowers = require('../services/borrowers');

const router = express.Router();

const FIELDS = [
  'title', 'contact_id', 'co_borrower_id', 'loan_purpose', 'loan_type', 'property_address', 'property_value', 'loan_amount',
  'deposit', 'lender_id', 'product_name', 'interest_rate', 'rate_type', 'fixed_expiry_date', 'loan_term_years',
  'repayment_type', 'priority', 'pre_approval_expiry', 'finance_due_date', 'settlement_date', 'application_ref',
  'lost_reason', 'owner_id', 'referral_partner_id',
];

const SELECT = `
  SELECT d.*, c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name, c.email AS contact_email,
         c.mobile AS contact_mobile, l.name AS lender_name, l.logo_asset_id AS lender_logo_id, u.name AS owner_name, p.name AS partner_name,
         ${borrowers.coNamesSql('deal', 'd')} AS co_borrower_name, c.entity_type AS contact_entity_type
  FROM deals d
  JOIN contacts c ON c.id = d.contact_id
  LEFT JOIN lenders l ON l.id = d.lender_id
  LEFT JOIN users u ON u.id = d.owner_id
  LEFT JOIN referral_partners p ON p.id = d.referral_partner_id`;

function checkLoanType(row) {
  if (row.loan_type && !LOAN_TYPE_KEYS.includes(row.loan_type)) throw new HttpError(400, 'Unknown loan type');
}

const withLvr = (d) => (d ? { ...d, lvr: lvr(d) } : d);

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push(`(d.title LIKE ? ESCAPE '\\' OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? ESCAPE '\\' OR d.property_address LIKE ? ESCAPE '\\' OR d.application_ref LIKE ? ESCAPE '\\'
      OR d.id IN (SELECT b.deal_id FROM deal_borrowers b JOIN contacts x ON x.id = b.contact_id WHERE x.first_name || ' ' || COALESCE(x.last_name,'') LIKE ? ESCAPE '\\'))`);
    params.push(like(req.query.q), like(req.query.q), like(req.query.q), like(req.query.q), like(req.query.q));
  }
  if (req.query.stage) { where.push('d.stage = ?'); params.push(req.query.stage); }
  if (req.query.open === '1') where.push("d.stage NOT IN ('settled','lost')");
  if (req.query.owner_id) { where.push('d.owner_id = ?'); params.push(req.query.owner_id); }
  if (req.query.lender_id) { where.push('d.lender_id = ?'); params.push(req.query.lender_id); }
  const rows = db.all(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC LIMIT 500`, ...params);
  res.json({ rows: rows.map(withLvr) });
});

// Kanban data: every stage with its deals.
router.get('/pipeline', (req, res) => {
  const params = [];
  let filter = '';
  if (req.query.owner_id) { filter = 'AND d.owner_id = ?'; params.push(req.query.owner_id); }
  const recentCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db.all(
    `${SELECT} WHERE (d.stage NOT IN ('settled','lost') OR d.stage_changed_at >= ?) ${filter} ORDER BY d.priority = 'high' DESC, d.stage_changed_at`,
    recentCutoff, ...params,
  );
  res.json({
    stages: STAGES.map((s) => {
      const deals = rows.filter((d) => d.stage === s.key).map(withLvr);
      return { ...s, deals, total: deals.reduce((sum, d) => sum + (d.loan_amount || 0), 0) };
    }),
  });
});

router.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const deal = withLvr(notFound(db.one(`${SELECT} WHERE d.id = ?`, id), 'Deal'));
  deal.documents = db.all('SELECT * FROM documents WHERE deal_id = ? ORDER BY category, name', id);
  deal.tasks = db.all(
    'SELECT t.*, u.name AS assigned_name FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to WHERE t.deal_id = ? ORDER BY t.status, t.due_date',
    id,
  );
  deal.activities = db.all(
    'SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC',
    id,
  );
  deal.commissions = db.all('SELECT * FROM commissions WHERE deal_id = ? ORDER BY period, id', id);
  deal.stage_history = db.all(
    'SELECT h.*, u.name AS user_name FROM deal_stage_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.deal_id = ? ORDER BY h.id',
    id,
  );
  deal.emails = db.all("SELECT id, to_email, subject, status, send_after, sent_at FROM outbox WHERE deal_id = ? AND COALESCE(sent_via,'') != 'outlook' AND internal = 0 ORDER BY id DESC", id);
  deal.sms = db.all(
    `SELECT s.id, s.body, s.status, s.error, s.from_number, s.send_after, s.sent_at, p.name AS partner_name
     FROM sms_messages s LEFT JOIN referral_partners p ON p.id = s.partner_id WHERE s.deal_id = ? ORDER BY s.id DESC LIMIT 50`,
    id,
  );
  deal.borrowers = borrowers.all('deal', id);
  deal.co_borrower_ids = deal.borrowers.filter((b) => b.role === 'co').map((b) => b.id);
  deal.mail = listEmails({ contactIds: borrowers.addresseesFor(deal.borrowers).map((b) => b.id).concat(deal.borrowers.map((b) => b.id)), limit: 50 });
  deal.parties = parties.list(deal.id);
  deal.other_securities = require('../services/securities').forDeal(deal.id);
  deal.sign_requests = require('../services/adobeSign').list({ dealId: deal.id });
  // The broker's accreditation number with this lender, and who to email there.
  const lenders = require('../services/lenders');
  deal.accreditation = lenders.accreditationOf(deal.lender_id, deal.owner_id);
  deal.lender_contacts = deal.lender_id ? lenders.contactsFor(deal.lender_id) : [];
  res.json(deal);
});

router.post('/', (req, res) => {
  const row = pick(req.body, FIELDS);
  requireFields(row, ['contact_id']);
  checkLoanType(row);
  if (!row.loan_type) row.loan_type = loanTypeForPurpose(row.loan_purpose);
  const contact = notFound(db.one('SELECT * FROM contacts WHERE id = ?', row.contact_id), 'Contact');
  const stage = req.body.stage && STAGE_KEYS.includes(req.body.stage) ? req.body.stage : 'lead';
  if (!row.title) row.title = `${contact.first_name} ${contact.last_name || ''} – ${(row.loan_purpose || 'purchase').replace('_', ' ')}`.replace(/\s+/g, ' ');
  if (row.owner_id === undefined) row.owner_id = contact.owner_id || req.user.id;
  // Co-borrowers: as given, else the client's partner.
  let co = borrowers.fromBody(req.body);
  if (co === undefined) co = [require('../services/household').partnerOf(contact.id)?.id].filter(Boolean);
  delete row.co_borrower_id;
  if (row.referral_partner_id === undefined && contact.referral_partner_id) row.referral_partner_id = contact.referral_partner_id;
  const id = db.transaction(() => {
    const dealId = db.insert('deals', { ...row, stage });
    borrowers.setCo('deal', dealId, co);
    db.insert('deal_stage_history', { deal_id: dealId, from_stage: null, to_stage: stage, changed_by: req.user.id });
    db.insert('activities', { contact_id: row.contact_id, deal_id: dealId, user_id: req.user.id, type: 'system', body: `Deal created: ${row.title}` });
    // Agent, solicitor, buyer's agent… captured on the New deal form.
    parties.setMany(dealId, req.body.parties, req.user.id);
    return dealId;
  });
  automation.emit('deal.created', { dealId: id });
  res.status(201).json(withLvr(db.one(`${SELECT} WHERE d.id = ?`, id)));
});

router.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const before = notFound(db.one('SELECT * FROM deals WHERE id = ?', id), 'Deal');
  const row = pick(req.body, FIELDS);
  if (row.contact_id === null) throw new HttpError(400, 'A deal must have a borrower');
  checkLoanType(row);
  if (row.loan_type === null) row.loan_type = loanTypeForPurpose(row.loan_purpose || before.loan_purpose);
  const co = borrowers.fromBody(req.body);
  delete row.co_borrower_id;
  db.transaction(() => {
    db.update('deals', id, { ...row, updated_at: nowIso() });
    // A new main borrower can't also be a co-borrower.
    if (co !== undefined || row.contact_id) borrowers.setCo('deal', id, co ?? borrowers.coIds('deal', id));
  });
  if (req.body.stage && req.body.stage !== before.stage) {
    if (!STAGE_KEYS.includes(req.body.stage)) throw new HttpError(400, 'Unknown stage');
    automation.changeDealStage(id, req.body.stage, req.user.id);
  }
  res.json(withLvr(db.one(`${SELECT} WHERE d.id = ?`, id)));
});

// ---- Purchase calculation (funds to complete) ------------------------------------
const purchaseCalc = require('../services/purchaseCalc');

function purchaseCalcFor(id) {
  const deal = notFound(db.one('SELECT * FROM deals WHERE id = ?', id), 'Deal');
  const saved = db.one(
    'SELECT p.*, u.name AS updated_by_name FROM deal_purchase_calcs p LEFT JOIN users u ON u.id = p.updated_by WHERE p.deal_id = ?', id,
  );
  const inputs = saved ? JSON.parse(saved.inputs) : purchaseCalc.fromDeal(deal);
  let result = null;
  let error = null;
  try {
    result = purchaseCalc.calculate(inputs);
  } catch (err) {
    error = err.message;
  }
  return {
    saved: Boolean(saved), updated_at: saved?.updated_at || null, updated_by_name: saved?.updated_by_name || null,
    inputs, result, error, suggested: purchaseCalc.PURCHASE_PURPOSES.includes(deal.loan_purpose),
  };
}

router.get('/:id/purchase-calc', (req, res) => res.json(purchaseCalcFor(intParam(req.params.id))));

// Saves the calculation; `apply_to_deal` also copies the price, loan and deposit onto the deal.
router.put('/:id/purchase-calc', (req, res) => {
  const id = intParam(req.params.id);
  const deal = notFound(db.one('SELECT * FROM deals WHERE id = ?', id), 'Deal');
  let result;
  try {
    result = purchaseCalc.calculate(req.body?.inputs || {});
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  db.run(
    `INSERT INTO deal_purchase_calcs (deal_id, inputs, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(deal_id) DO UPDATE SET inputs = excluded.inputs, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    id, JSON.stringify(result.inputs), req.user.id, nowIso(),
  );
  if (req.body?.apply_to_deal) {
    db.update('deals', id, {
      property_value: result.purchase_price, loan_amount: result.total_loan, deposit: result.deposit_required, updated_at: nowIso(),
    });
    db.insert('activities', {
      contact_id: deal.contact_id, deal_id: id, user_id: req.user.id, type: 'system',
      body: `Purchase calculation applied: price $${Math.round(result.purchase_price).toLocaleString('en-AU')}, loan $${Math.round(result.total_loan).toLocaleString('en-AU')} (${result.lvr_incl_lmi}% LVR), client contribution $${Math.round(result.total_contribution).toLocaleString('en-AU')}`,
    });
  }
  res.json(purchaseCalcFor(id));
});

router.delete('/:id/purchase-calc', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  db.run('DELETE FROM deal_purchase_calcs WHERE deal_id = ?', id);
  res.json(purchaseCalcFor(id));
});

// ---- Settlement letter -------------------------------------------------------------------
const settlementLetter = require('../services/settlementLetter');
const loanDocsAI = require('../services/loanDocsAI');

const letterResponse = (id) => {
  const letter = settlementLetter.get(id);
  return { ...letter, email: settlementLetter.emailDraft(id, letter.details), ai_configured: loanDocsAI.configured() };
};

router.get('/:id/settlement-letter', (req, res) => res.json(letterResponse(intParam(req.params.id))));

router.put('/:id/settlement-letter', (req, res) => {
  const id = intParam(req.params.id);
  settlementLetter.save(id, req.body?.details || {}, req.user.id);
  res.json(letterResponse(id));
});

// Reads uploaded loan documents with AI and fills in what it finds (saved as a
// draft for the broker to check). Body: { files: [{ name, mime, data }], details }.
router.post('/:id/settlement-letter/read', async (req, res) => {
  const id = intParam(req.params.id);
  const current = settlementLetter.clean(req.body?.details || settlementLetter.get(id).details);
  const found = await loanDocsAI.extract(req.body?.files);
  const read = settlementLetter.fromAI(found);
  const merged = settlementLetter.mergeExtracted(current, read);
  merged.uncertain = read.uncertain;
  settlementLetter.save(id, merged, req.user.id, { ai: { files: (req.body.files || []).map((f) => String(f.name || 'document').slice(0, 120)) } });
  res.json({ ...letterResponse(id), ai: { notes: found.notes || [], uncertain: read.uncertain, loans_found: read.loans.length } });
});

router.get('/:id/settlement-letter/preview', (req, res) => {
  const id = intParam(req.params.id);
  const html = require('../services/review').renderHtml(settlementLetter.model(id, settlementLetter.get(id).details, { userId: req.user.id }));
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html').send(html);
});

router.get('/:id/settlement-letter/pdf', async (req, res) => {
  const id = intParam(req.params.id);
  const { details } = settlementLetter.get(id);
  const pdf = await require('../services/review').renderPdf(settlementLetter.model(id, details, { userId: req.user.id }));
  const name = settlementLetter.fileName(details);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(pdf);
});

router.post('/:id/settlement-letter/email', async (req, res) => {
  const id = intParam(req.params.id);
  const r = await settlementLetter.send(id, pick(req.body, ['to', 'subject', 'body']), req.user.id);
  res.json({ ...letterResponse(id), outbox: { id: r.id, status: r.status, sent_via: r.sent_via } });
});

// ---- Quickli (servicing) --------------------------------------------------------------------
const quickli = require('../services/quickli');

const quickliResponse = (id, req) => {
  // A scenario that can't be built yet (e.g. a company with no directors linked) is explained, not an error.
  let built;
  try {
    built = quickli.buildScenario(id);
  } catch (err) {
    if (err.status !== 400) throw err;
    built = { summary: null, warnings: [], scenario: null, blocked: err.message };
  }
  return {
    blocked: built.blocked || null,
    configured: quickli.configured(),
    connected: Boolean(quickli.tokenStatus(req.user.id)),
    link: quickli.linkFor(id),
    summary: built.summary,
    warnings: built.warnings,
    scenario: built.scenario,
  };
};

router.get('/:id/quickli', (req, res) => res.json(quickliResponse(intParam(req.params.id), req)));
router.post('/:id/quickli/push', async (req, res) => {
  const id = intParam(req.params.id);
  await quickli.push(id, req.user.id);
  res.json(quickliResponse(id, req));
});
router.post('/:id/quickli/link', async (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  await quickli.link(id, req.body?.scenario_id, req.user.id);
  res.json(quickliResponse(id, req));
});
router.post('/:id/quickli/refresh', async (req, res) => {
  const id = intParam(req.params.id);
  await quickli.refresh(id, req.user.id);
  res.json(quickliResponse(id, req));
});
router.put('/:id/quickli/results', (req, res) => {
  const id = intParam(req.params.id);
  quickli.saveResults(id, req.body || {}, req.user.id);
  res.json(quickliResponse(id, req));
});
router.delete('/:id/quickli', (req, res) => {
  const id = intParam(req.params.id);
  quickli.unlink(id);
  res.json(quickliResponse(id, req));
});

// ---- Parties: agent, solicitor, buyer's agent… ------------------------------------
router.put('/:id/parties/:role', (req, res) => {
  const id = intParam(req.params.id);
  db.transaction(() => parties.set(id, req.params.role, req.body || {}, req.user.id));
  res.json({ parties: parties.list(id) });
});

router.delete('/:id/parties/:role', (req, res) => {
  const id = intParam(req.params.id);
  parties.remove(id, req.params.role);
  res.json({ parties: parties.list(id) });
});

router.post('/:id/stage', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  const { stage } = req.body || {};
  if (!STAGE_KEYS.includes(stage)) throw new HttpError(400, 'Unknown stage');
  const extra = pick(req.body, ['lost_reason', 'settlement_date', 'application_ref']);
  if (stage === 'lost' && !extra.lost_reason) throw new HttpError(400, 'Please give a reason the deal was lost');
  automation.changeDealStage(id, stage, req.user.id, extra);
  res.json(withLvr(db.one(`${SELECT} WHERE d.id = ?`, id)));
});

router.delete('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  db.run('DELETE FROM deals WHERE id = ?', id);
  res.json({ ok: true });
});

router.post('/:id/commissions/generate', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  res.json({ created: commissions.generateForDeal(id) });
});

// ---- Documents ------------------------------------------------------------

router.post('/:id/documents/checklist', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  res.json({ added: documents.createChecklist(id) });
});

router.post('/:id/documents', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  const row = safeLink(pick(req.body, ['name', 'category', 'status', 'link']));
  requireFields(row, ['name']);
  const docId = db.insert('documents', { ...row, deal_id: id });
  res.status(201).json(db.one('SELECT * FROM documents WHERE id = ?', docId));
});

// Emails the borrower the list of outstanding documents and marks them requested.
router.post('/:id/documents/request', async (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM deals WHERE id = ?', id), 'Deal');
  if (!documents.outstanding(id).length) throw new HttpError(400, 'There are no outstanding documents to request');
  const template = db.one("SELECT id FROM email_templates WHERE name = 'Document request'");
  if (!template) throw new HttpError(400, 'Create an email template named "Document request" first');
  const { id: outboxId, reason } = mailer.queueTemplate(template.id, { dealId: id, userId: req.user.id });
  if (!outboxId) throw new HttpError(400, reason);
  db.run("UPDATE documents SET status = 'requested', updated_at = ? WHERE deal_id = ? AND status = 'required'", nowIso(), id);
  await mailer.processOutbox();
  res.json(db.one('SELECT id, status, sent_via, error FROM outbox WHERE id = ?', outboxId));
});

module.exports = router;
