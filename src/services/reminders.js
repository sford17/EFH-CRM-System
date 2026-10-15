'use strict';
// Reminder emails to the broker (e.g. "Mia's annual review is due in 14
// days"), with a snapshot of the client to help prepare. These are internal:
// they aren't filed on the client's timeline.
const db = require('../db');
const { render } = require('./templating');
const { today, addDays, daysBetween, formatDate, money } = require('../util');

const DEFAULT_SUBJECT = 'Annual review due {{event.when}}: {{contact.full_name}}';
const DEFAULT_MESSAGE = 'Hi {{broker.first_name}},\n\n{{contact.full_name}}\'s annual review is due {{event.when}} ({{event.review_date|date}}). Here\'s a quick snapshot to help you prepare.';

// Address of the CRM for links in emails. Set APP_URL (or Settings →
// Business → CRM web address) when the CRM runs somewhere other than this PC.
function crmUrl(hash = '#/') {
  const base = (process.env.APP_URL || db.getSetting('app_url', '') || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  return `${base}/${hash}`;
}

// "today", "tomorrow", "in 14 days", "3 days ago".
function whenText(from, to) {
  const n = daysBetween(from, to);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 0 ? `in ${n} days` : `${-n} days ago`;
}

// The next anniversary of `date` on or after `from` (29 Feb → 28 Feb in
// other years), but never the original date itself.
function nextAnniversary(date, from) {
  const [, mm, dd] = date.split('-');
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  for (const y of [Number(from.slice(0, 4)), Number(from.slice(0, 4)) + 1]) {
    const day = mm === '02' && dd === '29' && !leap(y) ? '28' : dd;
    const candidate = `${y}-${mm}-${day}`;
    if (candidate >= from && candidate > date) return candidate;
  }
  return null;
}

// Clients whose annual review falls between `date` and `days_before` days
// later. The review date is the client's "next review date" if set,
// otherwise the anniversary of their most recent settlement. One row per
// household, so a couple isn't reminded twice.
function annualReviewsDue(cfg, date) {
  const until = addDays(date, cfg.days_before ?? 14);
  const rows = [];
  for (const c of db.all(
    `SELECT id, next_review_date AS d FROM contacts
     WHERE next_review_date BETWEEN ? AND ? AND status IN ('client','past_client') ORDER BY id`,
    date, until,
  )) rows.push({ contactId: c.id, k: c.d, source: 'next review date' });
  for (const s of db.all(
    `SELECT d.contact_id AS id, MAX(d.settlement_date) AS settled FROM deals d JOIN contacts c ON c.id = d.contact_id
     WHERE d.stage = 'settled' AND d.settlement_date IS NOT NULL AND c.next_review_date IS NULL AND c.status != 'lost'
     GROUP BY d.contact_id ORDER BY d.contact_id`,
  )) {
    const due = nextAnniversary(s.settled, date);
    if (due && due <= until) rows.push({ contactId: s.id, k: due, source: 'settlement anniversary' });
  }
  const household = require('./household');
  const seen = new Set();
  return rows.filter((r) => {
    const key = `${Math.min(...household.householdIds(r.contactId))}:${r.k}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((r) => ({
    contactId: r.contactId,
    k: r.k,
    event: { review_date: r.k, when: whenText(date, r.k), days_until: daysBetween(date, r.k), review_source: r.source },
  }));
}

const LOAN_LABELS = { home_loan: 'home loan', investment_loan: 'investment loan', line_of_credit: 'line of credit', credit_card: 'credit card', construction: 'construction loan', business_loan: 'business loan', smsf: 'SMSF loan' };

// Bullet points about the client: contact details, last review, loans
// needing attention, open deals.
function clientSnapshot(contactId) {
  const household = require('./household');
  const members = household.household(contactId);
  const ids = members.map((m) => m.id);
  const list = ids.map(() => '?').join(',');
  const lines = [];
  for (const m of members) {
    const contact = [m.mobile, m.email].filter(Boolean).join(' · ');
    lines.push(`- ${[m.first_name, m.last_name].filter(Boolean).join(' ')}${contact ? `: ${contact}` : ''}`);
  }
  const review = db.one(
    `SELECT title, review_date, status, sent_at FROM reviews WHERE contact_id IN (${list}) ORDER BY review_date DESC, id DESC LIMIT 1`,
    ...ids,
  );
  lines.push(review
    ? `- Last review: ${formatDate(review.review_date)}${review.status === 'sent' ? ' (emailed to the client)' : ' (draft)'}`
    : '- Last review: none on file');
  const soon = addDays(today(), 365);
  for (const n of db.all(
    `SELECT n.*, COALESCE(l.name, n.lender_name, 'Unknown lender') AS lender FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id
     WHERE n.status = 'active' AND (n.contact_id IN (${list}) OR n.id IN (SELECT loan_id FROM loan_borrowers WHERE contact_id IN (${list})))
       AND ((n.rate_type != 'variable' AND n.fixed_expiry_date BETWEEN ? AND ?) OR (n.repayment_type = 'io' AND n.io_expiry_date BETWEEN ? AND ?))
     ORDER BY COALESCE(n.fixed_expiry_date, n.io_expiry_date)`,
    ...ids, ...ids, today(), soon, today(), soon,
  )) {
    const what = `${n.lender} ${LOAN_LABELS[n.loan_type] || 'loan'}${n.balance ? ` (${money(n.balance)})` : ''}`;
    if (n.fixed_expiry_date && n.fixed_expiry_date <= soon && n.rate_type !== 'variable') lines.push(`- Fixed rate ends ${formatDate(n.fixed_expiry_date)}: ${what}`);
    if (n.repayment_type === 'io' && n.io_expiry_date && n.io_expiry_date <= soon) lines.push(`- Interest-only ends ${formatDate(n.io_expiry_date)}: ${what}`);
  }
  const open = db.one(`SELECT COUNT(*) AS n FROM deals WHERE (contact_id IN (${list}) OR id IN (SELECT deal_id FROM deal_borrowers WHERE contact_id IN (${list}))) AND stage NOT IN ('settled','lost')`, ...ids, ...ids).n;
  if (open) lines.push(`- ${open} open deal${open === 1 ? '' : 's'} in the pipeline`);
  return lines.join('\n');
}

// Characters that would end a [[button: … | …]] tag early.
const tagSafe = (s) => String(s || '').replace(/[|\]\n]/g, ' ').trim();

// Queues the reminder email (and a bell notification) for the broker.
function emailBroker(a, ctx, { automationId = null, sendAfter = null } = {}) {
  const mailer = require('./mailer');
  const spec = a.user && a.user !== 'owner' ? Number(a.user) : null;
  const userId = spec || ctx.deal?.owner_id || ctx.contact?.owner_id || null;
  const user = userId ? db.one('SELECT id, name, email, active FROM users WHERE id = ?', userId) : null;
  if (!user?.active || !user.email) return { id: null, reason: 'no active broker with an email address' };
  const hash = ctx.deal ? `#/deals/${ctx.deal.id}` : ctx.contact ? `#/contacts/${ctx.contact.id}?tab=tracker` : '#/';
  const c = { ...ctx, crm: { link: crmUrl(hash) } };
  const subject = render(a.subject || DEFAULT_SUBJECT, c).trim() || 'Reminder';
  const parts = [render(a.message || DEFAULT_MESSAGE, c)];
  if (ctx.contact && a.details !== 'none') parts.push(clientSnapshot(ctx.contact.id), '[[position]]', '[[lending_structure]]');
  const who = ctx.contact ? tagSafe(ctx.contact.single_first_name || ctx.contact.first_name) : '';
  parts.push(`[[button: ${who ? `Open ${who} in the CRM` : 'Open the CRM'} | ${c.crm.link}]]`);
  const id = mailer.queueEmail({
    to: user.email, subject, body: parts.join('\n\n'), contactId: ctx.contact?.id ?? null, dealId: ctx.deal?.id ?? null,
    loanId: ctx.loan?.id ?? null, automationId, senderUserId: user.id, sendAfter, internal: true,
  });
  db.insert('notifications', { user_id: user.id, message: subject, link: hash });
  return { id, reason: null, to: user.email };
}

module.exports = { annualReviewsDue, nextAnniversary, clientSnapshot, emailBroker, crmUrl, whenText, DEFAULT_SUBJECT, DEFAULT_MESSAGE };
