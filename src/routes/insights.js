'use strict';
const express = require('express');
const db = require('../db');
const commissionsSvc = require('../services/commissions');
const periods = require('../services/periods');
const { CALCULATORS } = require('../services/calculators');
const { STAGES, OPEN_STAGES } = require('../constants');
const { today, addDays, addMonths, nowIso, HttpError } = require('../util');
const { pick, requireFields, notFound, intParam, like, safeLink } = require('./helpers');

const router = express.Router();
const inList = (arr) => arr.map(() => '?').join(',');

router.get('/dashboard', (req, res) => {
  const t0 = today();
  const monthStart = `${t0.slice(0, 7)}-01`;
  const mine = req.query.mine === '1';
  const ownerSql = mine ? 'AND d.owner_id = ?' : '';
  const ownerArgs = mine ? [req.user.id] : [];

  const pipeline = db.one(
    `SELECT COUNT(*) AS count, COALESCE(SUM(loan_amount),0) AS volume FROM deals d WHERE stage IN (${inList(OPEN_STAGES)}) ${ownerSql}`,
    ...OPEN_STAGES, ...ownerArgs,
  );
  const settledMonth = db.one(
    `SELECT COUNT(*) AS count, COALESCE(SUM(loan_amount),0) AS volume FROM deals d WHERE stage = 'settled' AND settlement_date >= ? ${ownerSql}`,
    monthStart, ...ownerArgs,
  );
  const byStage = STAGES.filter((s) => OPEN_STAGES.includes(s.key)).map((s) => ({
    ...s,
    ...db.one(`SELECT COUNT(*) AS count, COALESCE(SUM(loan_amount),0) AS volume FROM deals d WHERE stage = ? ${ownerSql}`, s.key, ...ownerArgs),
  }));
  const newLeads = db.one('SELECT COUNT(*) AS count FROM contacts WHERE created_at >= ?', monthStart).count;
  const commissionMonth = db.one(
    "SELECT COALESCE(SUM(CASE WHEN status='received' THEN amount END),0) AS received, COALESCE(SUM(amount),0) AS expected FROM commissions WHERE period = ? AND status != 'cancelled'",
    t0.slice(0, 7),
  );
  const myTasks = db.all(
    `SELECT t.*, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, d.title AS deal_title
     FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id LEFT JOIN deals d ON d.id = t.deal_id
     WHERE t.status = 'open' AND t.assigned_to = ? AND (t.due_date IS NULL OR t.due_date <= ?)
     ORDER BY t.due_date IS NULL, t.due_date, t.priority = 'high' DESC LIMIT 25`,
    req.user.id, addDays(t0, 7),
  );
  const overdue = db.one("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open' AND due_date < ? AND assigned_to = ?", t0, req.user.id).count;
  const keyDates = db.all(
    `SELECT * FROM (
       SELECT d.id AS deal_id, d.title, 'Finance due' AS label, d.finance_due_date AS date FROM deals d
         WHERE d.stage IN (${inList(OPEN_STAGES)}) AND d.finance_due_date BETWEEN ? AND ? ${ownerSql}
       UNION ALL
       SELECT d.id, d.title, 'Settlement', d.settlement_date FROM deals d
         WHERE d.stage IN (${inList(OPEN_STAGES)}) AND d.settlement_date BETWEEN ? AND ? ${ownerSql}
       UNION ALL
       SELECT d.id, d.title, 'Pre-approval expires', d.pre_approval_expiry FROM deals d
         WHERE d.stage = 'pre_approval' AND d.pre_approval_expiry BETWEEN ? AND ? ${ownerSql}
     ) ORDER BY date LIMIT 30`,
    ...OPEN_STAGES, t0, addDays(t0, 30), ...ownerArgs,
    ...OPEN_STAGES, t0, addDays(t0, 30), ...ownerArgs,
    t0, addDays(t0, 30), ...ownerArgs,
  );
  // Fixed-rate and interest-only expiries from the mortgage tracker.
  const loanDates = db.all(
    `SELECT n.contact_id, c.first_name || ' ' || COALESCE(c.last_name,'') AS title, n.deal_id,
            CASE WHEN n.repayment_type = 'io' AND n.io_expiry_date BETWEEN ? AND ? THEN 'Interest-only ends' ELSE 'Fixed rate expires' END AS label,
            CASE WHEN n.repayment_type = 'io' AND n.io_expiry_date BETWEEN ? AND ? THEN n.io_expiry_date ELSE n.fixed_expiry_date END AS date,
            COALESCE(l.name, n.lender_name) AS lender
     FROM loans n JOIN contacts c ON c.id = n.contact_id LEFT JOIN lenders l ON l.id = n.lender_id
     WHERE n.status = 'active' ${mine ? 'AND c.owner_id = ?' : ''}
       AND ((n.rate_type IN ('fixed','split') AND n.fixed_expiry_date BETWEEN ? AND ?) OR (n.repayment_type = 'io' AND n.io_expiry_date BETWEEN ? AND ?))`,
    t0, addDays(t0, 120), t0, addDays(t0, 120), ...ownerArgs, t0, addDays(t0, 120), t0, addDays(t0, 120),
  );
  keyDates.push(...loanDates.map((r) => ({ ...r, title: `${r.title}${r.lender ? ` – ${r.lender}` : ''}` })));
  keyDates.sort((a, b) => a.date.localeCompare(b.date));
  const recentActivity = db.all(
    `SELECT a.*, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name, u.name AS user_name
     FROM activities a LEFT JOIN contacts c ON c.id = a.contact_id LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT 15`,
  );
  const appointments = db.all(
    `SELECT a.id, a.title, a.start_at, a.end_at, a.join_url, a.location, a.invitee_name, a.contact_id,
            c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name
     FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
     WHERE a.status = 'active' AND a.user_id = ? AND a.start_at >= ? AND a.start_at < ?
     ORDER BY a.start_at LIMIT 12`,
    req.user.id, new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 8 * 86400000).toISOString(),
  );
  const target = Number(db.getSetting('monthly_settlement_target', 0)) || 0;
  // Admins see a warning when backups are off or haven't worked lately.
  let backupWarning = null;
  if (req.user.role === 'admin') {
    const b = require('../services/backups').settings();
    const age = b.last_ok_at ? (Date.now() - Date.parse(b.last_ok_at)) / 86400000 : null;
    const started = db.one('SELECT MIN(created_at) AS t FROM users').t;
    const settled = started && (Date.now() - Date.parse(started)) / 86400000 > 2;
    if (!b.enabled) backupWarning = 'Automatic backups are switched off.';
    else if (b.last_error) backupWarning = `The last backup didn't work: ${b.last_error}`;
    else if ((age === null && settled) || age > 3) backupWarning = age === null ? 'No backup has been made yet.' : `There's been no backup for ${Math.floor(age)} days.`;
  }
  res.json({
    backup_warning: backupWarning,
    pipeline, settled_month: settledMonth, by_stage: byStage, new_leads_month: newLeads,
    commission_month: commissionMonth, my_tasks: myTasks, overdue_tasks: overdue, key_dates: keyDates,
    recent_activity: recentActivity, settlement_target: target, appointments,
  });
});

router.get('/reports/periods', (req, res) => res.json(periods.yearOptions()));

router.get('/reports', (req, res) => {
  const period = periods.resolve(req.query);
  const { from, to } = period;
  res.json({
    period, from, to,
    settlements_by_month: db.all(
      `SELECT substr(settlement_date,1,7) AS month, COUNT(*) AS count, SUM(loan_amount) AS volume
       FROM deals WHERE stage = 'settled' AND settlement_date BETWEEN ? AND ? GROUP BY month ORDER BY month`,
      from, to,
    ),
    lead_sources: db.all(
      `SELECT COALESCE(c.lead_source,'unknown') AS source, COUNT(DISTINCT c.id) AS contacts,
              COUNT(DISTINCT CASE WHEN d.stage = 'settled' THEN d.id END) AS settled,
              COALESCE(SUM(CASE WHEN d.stage = 'settled' THEN d.loan_amount END),0) AS volume
       FROM contacts c LEFT JOIN deals d ON d.contact_id = c.id
       WHERE substr(c.created_at,1,10) BETWEEN ? AND ? GROUP BY source ORDER BY contacts DESC`,
      from, to,
    ),
    lenders: db.all(
      `SELECT COALESCE(l.name,'(none)') AS lender, COUNT(*) AS count, SUM(d.loan_amount) AS volume
       FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id
       WHERE d.stage = 'settled' AND d.settlement_date BETWEEN ? AND ? GROUP BY lender ORDER BY volume DESC`,
      from, to,
    ),
    partners: db.all(
      `SELECT p.name, p.company, COUNT(DISTINCT c.id) AS referrals,
              COUNT(DISTINCT CASE WHEN d.stage='settled' THEN d.id END) AS settled,
              COALESCE(SUM(CASE WHEN d.stage='settled' THEN d.loan_amount END),0) AS volume
       FROM referral_partners p LEFT JOIN contacts c ON c.referral_partner_id = p.id
       LEFT JOIN deals d ON d.contact_id = c.id GROUP BY p.id ORDER BY volume DESC, referrals DESC`,
    ),
    lost_reasons: db.all(
      `SELECT COALESCE(lost_reason,'(not given)') AS reason, COUNT(*) AS count FROM deals
       WHERE stage = 'lost' AND substr(stage_changed_at,1,10) BETWEEN ? AND ? GROUP BY reason ORDER BY count DESC`,
      from, to,
    ),
    conversion: db.all(
      `SELECT to_stage AS stage, COUNT(DISTINCT deal_id) AS deals FROM deal_stage_history
       WHERE substr(changed_at,1,10) BETWEEN ? AND ? GROUP BY to_stage`,
      from, to,
    ),
    commission_by_month: db.all(
      `SELECT period AS month,
              SUM(CASE WHEN type='upfront' THEN amount ELSE 0 END) AS upfront,
              SUM(CASE WHEN type IN ('clawback','referral_fee') THEN amount ELSE 0 END) AS deductions,
              SUM(CASE WHEN status='received' THEN amount ELSE 0 END) AS received,
              SUM(amount) AS total
       FROM commissions WHERE status != 'cancelled' AND period BETWEEN ? AND ? GROUP BY period ORDER BY period`,
      from.slice(0, 7), to.slice(0, 7),
    ),
    avg_days_to_settle: db.one(
      `SELECT ROUND(AVG(julianday(d.settlement_date) - julianday(substr(d.created_at,1,10)))) AS days
       FROM deals d WHERE d.stage = 'settled' AND d.settlement_date BETWEEN ? AND ?`,
      from, to,
    ).days,
  });
});

// ---- Running settlements (settled + expected, by month, for a financial year) ----
const settlementReport = require('../services/settlementReport');
const settlementArgs = (q) => ({ period: periods.resolve(q), ownerId: Number(q.owner_id) || null });

router.get('/reports/settlements', (req, res) => res.json(settlementReport.report(settlementArgs(req.query))));

router.get('/reports/settlements.csv', (req, res) => {
  const r = settlementReport.report(settlementArgs(req.query));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const p = r.period;
  const tag = p.type === 'fy' ? `FY${String(p.fy).slice(2)}` : p.type === 'cy' ? String(p.year) : `${p.from}-to-${p.to}`;
  res.setHeader('Content-Disposition', `attachment; filename="settlements-${tag}.csv"`);
  res.send(require('../csv').stringify(settlementReport.csvRows(r)));
});

// ---- Internal refinance register ------------------------------------------------
const refinances = require('../services/internalRefinances');
const refinanceArgs = (q) => ({
  period: q.period === 'all' ? null : periods.resolve(q),
  ownerId: Number(q.owner_id) || null,
  lenderId: Number(q.lender_id) || null,
  status: q.status || null,
  contactId: Number(q.contact_id) || null,
  q: q.q ? String(q.q).slice(0, 100) : null,
});
const refinancePeriod = (q) => (q.period === 'all' ? { type: 'all', label: 'All dates', short: 'all dates' } : periods.resolve(q));

router.get('/refinances', (req, res) => res.json({ period: refinancePeriod(req.query), ...refinances.list(refinanceArgs(req.query)) }));

router.get('/refinances.csv', (req, res) => {
  const p = refinancePeriod(req.query);
  const tag = p.type === 'all' ? 'all' : p.type === 'fy' ? `FY${String(p.fy).slice(2)}` : p.type === 'cy' ? String(p.year) : `${p.from}-to-${p.to}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="internal-refinances-${tag}.csv"`);
  res.send(require('../csv').stringify(refinances.csvRows(refinances.list(refinanceArgs(req.query)).rows), refinances.CSV_COLUMNS));
});

router.get('/refinances/options/:contactId', (req, res) => res.json(notFound(refinances.options(intParam(req.params.contactId)), 'Contact')));
router.get('/refinances/:id', (req, res) => res.json(notFound(refinances.get(intParam(req.params.id)), 'Refinance')));
router.post('/refinances', (req, res) => res.status(201).json(refinances.create(req.body || {}, req.user.id)));
router.put('/refinances/:id', (req, res) => res.json(notFound(refinances.update(intParam(req.params.id), req.body || {}), 'Refinance')));
router.delete('/refinances/:id', (req, res) => {
  if (!refinances.remove(intParam(req.params.id))) throw new HttpError(404, 'Refinance not found');
  res.status(204).end();
});

// ---- Commissions ---------------------------------------------------------------
router.get('/commissions', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('cm.status = ?'); params.push(req.query.status); }
  if (req.query.type) { where.push('cm.type = ?'); params.push(req.query.type); }
  if (req.query.from) { where.push('cm.period >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('cm.period <= ?'); params.push(req.query.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(
    `SELECT cm.*, d.title AS deal_title, l.name AS lender_name FROM commissions cm
     JOIN deals d ON d.id = cm.deal_id LEFT JOIN lenders l ON l.id = d.lender_id
     ${whereSql} ORDER BY cm.period DESC, cm.id DESC LIMIT 1000`,
    ...params,
  );
  const totals = db.one(
    `SELECT COALESCE(SUM(CASE WHEN cm.status='expected' THEN amount END),0) AS expected,
            COALESCE(SUM(CASE WHEN cm.status IN ('received','paid') THEN amount END),0) AS received
     FROM commissions cm ${whereSql}`,
    ...params,
  );
  res.json({ rows, totals, clawback_exposure: commissionsSvc.clawbackExposure() });
});

router.post('/commissions', (req, res) => {
  const row = pick(req.body, ['deal_id', 'type', 'amount', 'period', 'status', 'notes', 'received_at']);
  requireFields(row, ['deal_id', 'type', 'amount']);
  if (!['upfront', 'clawback', 'referral_fee', 'other'].includes(row.type)) throw new HttpError(400, 'Type must be upfront, clawback, referral fee or other');
  if (row.type === 'clawback' && row.amount > 0) row.amount = -row.amount;
  const id = db.insert('commissions', row);
  res.status(201).json(db.one('SELECT * FROM commissions WHERE id = ?', id));
});

router.patch('/commissions/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM commissions WHERE id = ?', id), 'Commission');
  const row = pick(req.body, ['amount', 'period', 'status', 'notes', 'received_at']);
  if (row.status === 'received' && !row.received_at) row.received_at = today();
  db.update('commissions', id, row);
  res.json(db.one('SELECT * FROM commissions WHERE id = ?', id));
});

router.delete('/commissions/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM commissions WHERE id = ?', id), 'Commission');
  db.run('DELETE FROM commissions WHERE id = ?', id);
  res.json({ ok: true });
});

// ---- Documents & activities (edits by id) ------------------------------------------
router.patch('/documents/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM documents WHERE id = ?', id), 'Document');
  db.update('documents', id, { ...safeLink(pick(req.body, ['name', 'category', 'status', 'link'])), updated_at: nowIso() });
  res.json(db.one('SELECT * FROM documents WHERE id = ?', id));
});

router.delete('/documents/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM documents WHERE id = ?', id), 'Document');
  db.run('DELETE FROM documents WHERE id = ?', id);
  res.json({ ok: true });
});

router.delete('/activities/:id', (req, res) => {
  const id = intParam(req.params.id);
  const act = notFound(db.one('SELECT * FROM activities WHERE id = ?', id), 'Activity');
  if (act.type === 'system') throw new HttpError(400, 'System history entries cannot be deleted');
  if (act.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'You can only delete your own entries');
  db.run('DELETE FROM activities WHERE id = ?', id);
  res.json({ ok: true });
});

// ---- Search, notifications, calculators -----------------------------------------
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ contacts: [], deals: [] });
  const p = like(q);
  res.json({
    contacts: db.all(
      `SELECT id, first_name, last_name, email, mobile, status FROM contacts
       WHERE first_name || ' ' || COALESCE(last_name,'') LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR mobile LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT 8`,
      p, p, p, p,
    ),
    deals: db.all(
      `SELECT id, title, stage, loan_amount FROM deals
       WHERE title LIKE ? ESCAPE '\\' OR property_address LIKE ? ESCAPE '\\' OR application_ref LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT 8`,
      p, p, p,
    ),
  });
});

router.get('/notifications', (req, res) => {
  res.json({
    rows: db.all('SELECT * FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT 50', req.user.id),
    unread: db.one('SELECT COUNT(*) AS n FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read = 0', req.user.id).n,
  });
});

router.post('/notifications/read', (req, res) => {
  db.run('UPDATE notifications SET read = 1 WHERE user_id = ? OR user_id IS NULL', req.user.id);
  res.json({ ok: true });
});

router.post('/calculators/:type', (req, res) => {
  const fn = Object.hasOwn(CALCULATORS, req.params.type) ? CALCULATORS[req.params.type] : null;
  if (!fn) throw new HttpError(404, 'Unknown calculator');
  try {
    res.json(fn(req.body || {}));
  } catch (err) {
    throw new HttpError(400, err.message);
  }
});

// Running costs: Anthropic (Claude) usage and SMS.
router.get('/reports/costs', (req, res) => {
  const period = periods.resolve(req.query);
  res.json({ period, ...require('../services/costs').report(period) });
});
router.put('/reports/costs/settings', require('../auth').requireRole('admin'), (req, res) => res.json(require('../services/costs').saveSettings(req.body || {})));

module.exports = router;
