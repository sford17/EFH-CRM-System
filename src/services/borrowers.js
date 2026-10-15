'use strict';
// Borrowers on a deal or loan: the main borrower (contact_id) plus any number
// of co-borrowers, kept in order in deal_borrowers / loan_borrowers. Database
// triggers keep deals.co_borrower_id / loans.co_borrower_id set to the first
// co-borrower, for code that only needs one.
//
// A borrower can be a person, a company or a trust. Companies and trusts are
// contacts too, linked to their people (directors, trustees…) as relationships.
const db = require('../db');
const { HttpError } = require('../util');

const KINDS = {
  deal: { table: 'deal_borrowers', key: 'deal_id', parent: 'deals' },
  loan: { table: 'loan_borrowers', key: 'loan_id', parent: 'loans' },
};
const ENTITY_TYPES = ['person', 'company', 'trust'];
// How people are linked to a company or trust (stored person → entity).
const ENTITY_ROLES = ['director', 'shareholder', 'trustee', 'beneficiary', 'appointor', 'guarantor'];

const kindOf = (kind) => {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unknown borrower kind ${kind}`);
  return k;
};
const PERSON = "id, first_name, last_name, email, mobile, entity_type, first_name || CASE WHEN last_name IS NULL OR last_name = '' THEN '' ELSE ' ' || last_name END AS full_name";

// Co-borrower contact ids, in order.
function coIds(kind, id) {
  const k = kindOf(kind);
  return db.all(`SELECT contact_id FROM ${k.table} WHERE ${k.key} = ? ORDER BY position, id`, id).map((r) => r.contact_id);
}

// Everyone on it: the main borrower first, then the co-borrowers.
function all(kind, id) {
  const k = kindOf(kind);
  const row = db.one(`SELECT contact_id FROM ${k.parent} WHERE id = ?`, id);
  if (!row) return [];
  return [row.contact_id, ...coIds(kind, id)]
    .map((cid, i) => {
      const c = db.one(`SELECT ${PERSON} FROM contacts WHERE id = ?`, cid);
      return c ? { ...c, role: i === 0 ? 'main' : 'co' } : null;
    })
    .filter(Boolean);
}

// Replaces the co-borrowers (in the order given). The main borrower and repeats are skipped.
function setCo(kind, id, ids) {
  const k = kindOf(kind);
  const row = db.one(`SELECT contact_id FROM ${k.parent} WHERE id = ?`, id);
  if (!row) throw new HttpError(404, 'Not found');
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== row.contact_id))];
  for (const cid of clean) {
    if (!db.one('SELECT 1 FROM contacts WHERE id = ?', cid)) throw new HttpError(400, `Contact #${cid} not found`);
  }
  db.transaction(() => {
    db.run(`DELETE FROM ${k.table} WHERE ${k.key} = ?`, id);
    clean.forEach((cid, position) => db.insert(k.table, { [k.key]: id, contact_id: cid, position }));
  });
  return clean;
}

// Reads co-borrowers from a request body: co_borrower_ids (a list), or the older single co_borrower_id.
function fromBody(body) {
  if (Array.isArray(body?.co_borrower_ids)) return body.co_borrower_ids;
  if (body && 'co_borrower_id' in body) return body.co_borrower_id ? [body.co_borrower_id] : [];
  return undefined;
}

// SQL for "deals (or loans) any of these contacts borrow on". Use with params(ids).
function involving(kind, alias, ids) {
  const k = kindOf(kind);
  const q = ids.map(() => '?').join(',') || 'NULL';
  return `(${alias}.contact_id IN (${q}) OR ${alias}.id IN (SELECT ${k.key} FROM ${k.table} WHERE contact_id IN (${q})))`;
}
const params = (ids) => [...ids, ...ids];

// "Mia Jones, Tom Jones & Ford Family Trust" style names for a deal/loan's co-borrowers, as a SQL expression.
const coNamesSql = (kind, alias) => {
  const k = kindOf(kind);
  return `(SELECT group_concat(n, ' & ') FROM (SELECT x.first_name || COALESCE(' ' || NULLIF(x.last_name, ''), '') AS n
    FROM ${k.table} b JOIN contacts x ON x.id = b.contact_id WHERE b.${k.key} = ${alias}.id ORDER BY b.position, b.id))`;
};

// The people behind a company or trust (directors, trustees…), for emails and signing.
function peopleOf(entityId) {
  return db.all(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, c.entity_type, r.relationship FROM contact_relationships r
     JOIN contacts c ON c.id = CASE WHEN r.contact_id = ? THEN r.related_id ELSE r.contact_id END
     WHERE (r.contact_id = ? OR r.related_id = ?) AND r.relationship IN (${ENTITY_ROLES.map(() => '?').join(',')}) AND c.entity_type = 'person'
     ORDER BY CASE r.relationship WHEN 'director' THEN 0 WHEN 'trustee' THEN 1 ELSE 2 END, c.id`,
    entityId, entityId, entityId, ...ENTITY_ROLES,
  );
}

// The companies and trusts a person is linked to.
function entitiesOf(personId) {
  return db.all(
    `SELECT c.id, c.first_name, c.entity_type, r.relationship FROM contact_relationships r
     JOIN contacts c ON c.id = CASE WHEN r.contact_id = ? THEN r.related_id ELSE r.contact_id END
     WHERE (r.contact_id = ? OR r.related_id = ?) AND c.entity_type != 'person'`,
    personId, personId, personId,
  );
}

// People to write to for a list of borrowers: companies and trusts are swapped
// for their directors/trustees (kept as themselves if no one is linked).
function addresseesFor(contacts) {
  const out = new Map();
  for (const c of contacts) {
    if (!c) continue;
    const people = c.entity_type && c.entity_type !== 'person' ? peopleOf(c.id) : [];
    for (const p of people.length ? people : [c]) if (!out.has(p.id)) out.set(p.id, p);
  }
  return [...out.values()];
}

module.exports = {
  KINDS, ENTITY_TYPES, ENTITY_ROLES, coIds, all, setCo, fromBody, involving, params, coNamesSql, peopleOf, entitiesOf, addresseesFor,
};
