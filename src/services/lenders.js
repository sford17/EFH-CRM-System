'use strict';
// People at each lender (BDMs, scenario desk, credit…) and each broker's
// accreditation with the lender.
const db = require('../db');
const { HttpError, nowIso, today } = require('../util');

const CONTACT_ROLES = {
  bdm: 'BDM',
  assistant_bdm: 'Assistant BDM',
  scenario_desk: 'Scenario desk',
  credit: 'Credit',
  settlements: 'Settlements',
  broker_support: 'Broker support',
  other: 'Other',
};
const ACCREDITATION_STATUSES = {
  active: 'Accredited',
  pending: 'Pending',
  suspended: 'Suspended',
  not_accredited: 'Not accredited',
};
const CONTACT_FIELDS = ['name', 'role', 'email', 'phone', 'mobile', 'region', 'notes', 'is_primary'];
const ACCREDITATION_FIELDS = ['accreditation_number', 'status', 'accredited_on', 'renewal_due', 'notes'];
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v) => (v === undefined ? undefined : v === null || String(v).trim() === '' ? null : String(v).trim());
const has = (obj, key) => Object.hasOwn(obj || {}, key);

function lenderOrThrow(lenderId) {
  const lender = db.one('SELECT id, name FROM lenders WHERE id = ?', lenderId);
  if (!lender) throw new HttpError(404, 'Lender not found');
  return lender;
}

// ---- Contacts ------------------------------------------------------------------

function contactRow(input, { partial }) {
  const row = {};
  for (const k of CONTACT_FIELDS) if (has(input, k)) row[k] = k === 'is_primary' ? (input[k] ? 1 : 0) : clean(input[k]);
  if (!partial || has(row, 'name')) if (!row.name) throw new HttpError(400, 'Enter the contact\'s name');
  if (has(row, 'role') || !partial) {
    row.role = row.role || 'bdm';
    if (!Object.hasOwn(CONTACT_ROLES, row.role)) throw new HttpError(400, 'Unknown role');
  }
  if (row.email && !EMAIL_RE.test(row.email)) throw new HttpError(400, `${row.email} doesn't look like an email address`);
  if (row.email) row.email = row.email.toLowerCase();
  return row;
}

// Only one primary contact per lender (the one shown on the Lenders list).
function setPrimary(lenderId, contactId) {
  db.run('UPDATE lender_contacts SET is_primary = (id = ?) WHERE lender_id = ?', contactId, lenderId);
}

function addContact(lenderId, input) {
  lenderOrThrow(lenderId);
  return db.transaction(() => {
    const row = contactRow(input, { partial: false });
    const first = !db.one('SELECT 1 FROM lender_contacts WHERE lender_id = ?', lenderId);
    const id = db.insert('lender_contacts', { ...row, lender_id: lenderId, is_primary: 0 });
    if (row.is_primary || (first && row.role === 'bdm')) setPrimary(lenderId, id);
    return getContact(id);
  });
}

function updateContact(id, input) {
  const before = getContact(id);
  if (!before) throw new HttpError(404, 'Contact not found');
  return db.transaction(() => {
    const { is_primary: primary, ...row } = contactRow(input, { partial: true });
    if (Object.keys(row).length) db.update('lender_contacts', id, row);
    if (primary === 1) setPrimary(before.lender_id, id);
    else if (primary === 0) db.run('UPDATE lender_contacts SET is_primary = 0 WHERE id = ?', id);
    return getContact(id);
  });
}

function removeContact(id) {
  if (!db.run('DELETE FROM lender_contacts WHERE id = ?', id).changes) throw new HttpError(404, 'Contact not found');
}

const withLabels = (c) => (c ? { ...c, is_primary: Boolean(c.is_primary), role_label: CONTACT_ROLES[c.role] } : c);
const getContact = (id) => withLabels(db.one('SELECT * FROM lender_contacts WHERE id = ?', id));

function contactsFor(lenderId) {
  return db.all(
    `SELECT * FROM lender_contacts WHERE lender_id = ?
     ORDER BY is_primary DESC, CASE role WHEN 'bdm' THEN 0 WHEN 'assistant_bdm' THEN 1 ELSE 2 END, name`,
    lenderId,
  ).map(withLabels);
}

// The lender a set of email addresses belongs to (via its contacts), if any.
function lenderForAddresses(addresses) {
  const list = [...new Set(addresses.filter(Boolean).map((a) => String(a).toLowerCase()))];
  if (!list.length) return null;
  return db.one(`SELECT lender_id FROM lender_contacts WHERE lower(email) IN (${list.map(() => '?').join(',')}) LIMIT 1`, ...list)?.lender_id ?? null;
}

// "Westpac (Jane Smith, BDM)" for timeline entries.
function describeRecipient(lenderId, address) {
  const lender = db.one('SELECT name FROM lenders WHERE id = ?', lenderId);
  if (!lender) return null;
  const person = address ? db.one('SELECT name, role FROM lender_contacts WHERE lender_id = ? AND lower(email) = lower(?)', lenderId, address) : null;
  return person ? `${lender.name} (${person.name}, ${CONTACT_ROLES[person.role]})` : lender.name;
}

// ---- Accreditations -----------------------------------------------------------------

function accreditationsFor(lenderId) {
  return db.all(
    `SELECT a.*, u.name AS user_name FROM lender_accreditations a JOIN users u ON u.id = a.user_id
     WHERE a.lender_id = ? ORDER BY u.name`,
    lenderId,
  ).map(decorateAccreditation);
}

function decorateAccreditation(a) {
  if (!a) return a;
  const due = a.renewal_due;
  return {
    ...a,
    status_label: ACCREDITATION_STATUSES[a.status],
    renewal_overdue: Boolean(due && due < today()),
    renewal_soon: Boolean(due && due >= today() && due <= addDaysIso(60)),
  };
}

function addDaysIso(n) {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Brokers manage their own accreditations; admins can manage anyone's.
function canManage(actor, userId) {
  return actor.role === 'admin' || actor.id === Number(userId);
}

function saveAccreditation(lenderId, userId, input, actor) {
  lenderOrThrow(lenderId);
  if (!db.one('SELECT 1 FROM users WHERE id = ?', userId)) throw new HttpError(400, 'Unknown team member');
  if (!canManage(actor, userId)) throw new HttpError(403, 'You can only change your own accreditations');
  const row = {};
  for (const k of ACCREDITATION_FIELDS) if (has(input, k)) row[k] = clean(input[k]);
  if (row.status !== undefined) {
    row.status = row.status || 'active';
    if (!Object.hasOwn(ACCREDITATION_STATUSES, row.status)) throw new HttpError(400, 'Unknown status');
  }
  for (const k of ['accredited_on', 'renewal_due']) if (row[k] && !DATE_RE.test(row[k])) throw new HttpError(400, 'Dates must be YYYY-MM-DD');
  if (row.accreditation_number && row.accreditation_number.length > 60) throw new HttpError(400, 'That accreditation number is too long');
  const existing = db.one('SELECT id FROM lender_accreditations WHERE lender_id = ? AND user_id = ?', lenderId, userId);
  if (existing) db.update('lender_accreditations', existing.id, { ...row, updated_at: nowIso() });
  else db.insert('lender_accreditations', { status: 'active', ...row, lender_id: lenderId, user_id: Number(userId) });
  return decorateAccreditation(db.one(
    'SELECT a.*, u.name AS user_name FROM lender_accreditations a JOIN users u ON u.id = a.user_id WHERE a.lender_id = ? AND a.user_id = ?',
    lenderId, userId,
  ));
}

function removeAccreditation(id, actor) {
  const a = db.one('SELECT * FROM lender_accreditations WHERE id = ?', id);
  if (!a) throw new HttpError(404, 'Accreditation not found');
  if (!canManage(actor, a.user_id)) throw new HttpError(403, 'You can only change your own accreditations');
  db.run('DELETE FROM lender_accreditations WHERE id = ?', id);
}

// A broker's accreditation with a lender (shown on deals).
const accreditationOf = (lenderId, userId) => (lenderId && userId
  ? decorateAccreditation(db.one('SELECT * FROM lender_accreditations WHERE lender_id = ? AND user_id = ?', lenderId, userId))
  : null);

module.exports = {
  CONTACT_ROLES, ACCREDITATION_STATUSES,
  addContact, updateContact, removeContact, getContact, contactsFor, lenderForAddresses, describeRecipient,
  accreditationsFor, saveAccreditation, removeAccreditation, accreditationOf,
};
