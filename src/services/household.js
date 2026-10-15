'use strict';
// Related contacts. A relationship can mark two people as sharing finances
// (a household, e.g. a married couple): their mortgage tracker is combined,
// their address is kept in step, joint deals default to both borrowers, and
// documents/emails can be addressed to both.
const db = require('../db');
const { nowIso, HttpError } = require('../util');

const TYPES = ['spouse', 'de_facto', 'partner', 'parent', 'child', 'sibling', 'relative', 'business_partner', 'guarantor', 'accountant', 'solicitor', 'other',
  'director', 'shareholder', 'trustee', 'beneficiary', 'appointor'];
// Roles a person has in a company or trust; stored with the person as contact_id.
const ENTITY_ROLES = ['director', 'shareholder', 'trustee', 'beneficiary', 'appointor', 'guarantor'];
const REVERSE = { parent: 'child', child: 'parent' };
const ADDRESS = ['address', 'suburb', 'state', 'postcode'];

function link(contactId, relatedId, { relationship = 'spouse', shared_finances = false, copy_address = true, notes = null } = {}) {
  if (Number(contactId) === Number(relatedId)) throw new HttpError(400, 'A contact can\'t be related to themselves');
  if (!TYPES.includes(relationship)) throw new HttpError(400, 'Unknown relationship');
  let a = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
  let b = db.one('SELECT * FROM contacts WHERE id = ?', relatedId);
  if (!a || !b) throw new HttpError(404, 'Contact not found');
  // A company or trust and one of its people: always stored person → entity.
  if (a.entity_type !== 'person' && b.entity_type === 'person') [a, b] = [b, a];
  const entityLink = a.entity_type !== 'person' || b.entity_type !== 'person';
  if (entityLink) {
    if (b.entity_type !== 'person' && a.entity_type === 'person' && !ENTITY_ROLES.includes(relationship) && !['accountant', 'solicitor', 'other'].includes(relationship)) {
      throw new HttpError(400, `Choose how they're linked to ${b.first_name}, e.g. director or trustee`);
    }
    shared_finances = false; // finances are combined between people, not with a company or trust
  } else if (['director', 'shareholder', 'trustee', 'beneficiary', 'appointor'].includes(relationship)) {
    throw new HttpError(400, 'Director, trustee and similar roles link a person to a company or trust');
  }
  if (db.one('SELECT 1 FROM contact_relationships WHERE (contact_id = ? AND related_id = ?) OR (contact_id = ? AND related_id = ?)', a.id, b.id, b.id, a.id)) {
    throw new HttpError(409, `${a.first_name} and ${b.first_name} are already linked`);
  }
  const id = db.insert('contact_relationships', {
    contact_id: a.id, related_id: b.id, relationship, shared_finances: shared_finances ? 1 : 0, notes,
  });
  if (shared_finances && copy_address) fillAddress(a, b);
  return id;
}

// Fills a blank address on either person from the other.
function fillAddress(a, b) {
  const has = (c) => ADDRESS.some((k) => c[k]);
  const [from, to] = has(a) && !has(b) ? [a, b] : has(b) && !has(a) ? [b, a] : [null, null];
  if (!from) return false;
  db.update('contacts', to.id, { ...Object.fromEntries(ADDRESS.map((k) => [k, from[k]])), updated_at: nowIso() });
  return true;
}

function update(id, { relationship, shared_finances, notes }) {
  const row = db.one('SELECT * FROM contact_relationships WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Relationship not found');
  const patch = {};
  if (relationship !== undefined) {
    if (!TYPES.includes(relationship)) throw new HttpError(400, 'Unknown relationship');
    patch.relationship = relationship;
  }
  if (shared_finances !== undefined) patch.shared_finances = shared_finances ? 1 : 0;
  if (notes !== undefined) patch.notes = notes;
  db.update('contact_relationships', id, patch);
  return db.one('SELECT * FROM contact_relationships WHERE id = ?', id);
}

function unlink(id) {
  if (!db.run('DELETE FROM contact_relationships WHERE id = ?', id).changes) throw new HttpError(404, 'Relationship not found');
}

// Relationships from one contact's point of view (parent/child reversed).
function relatedTo(contactId) {
  return db.all(
    `SELECT r.id, r.related_id AS other_id, r.relationship, r.shared_finances, r.notes, 0 AS reversed FROM contact_relationships r WHERE r.contact_id = ?
     UNION ALL
     SELECT r.id, r.contact_id, r.relationship, r.shared_finances, r.notes, 1 FROM contact_relationships r WHERE r.related_id = ?`,
    contactId, contactId,
  ).map((r) => {
    const c = db.one('SELECT id, first_name, last_name, email, mobile, status, entity_type FROM contacts WHERE id = ?', r.other_id);
    return {
      id: r.id,
      relationship: r.reversed ? REVERSE[r.relationship] || r.relationship : r.relationship,
      shared_finances: Boolean(r.shared_finances),
      reversed: Boolean(r.reversed),
      notes: r.notes,
      contact: { ...c, full_name: [c.first_name, c.last_name].filter(Boolean).join(' ') },
    };
  });
}

// Everyone sharing finances with this contact (directly or through each other).
function householdIds(contactId) {
  const seen = new Set([Number(contactId)]);
  const queue = [Number(contactId)];
  while (queue.length && seen.size < 12) {
    const id = queue.shift();
    for (const r of db.all('SELECT contact_id, related_id FROM contact_relationships WHERE shared_finances = 1 AND (contact_id = ? OR related_id = ?)', id, id)) {
      const other = r.contact_id === id ? r.related_id : r.contact_id;
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return [...seen];
}

function household(contactId) {
  return householdIds(contactId).map((id) => db.one('SELECT id, first_name, last_name, email, mobile FROM contacts WHERE id = ?', id)).filter(Boolean);
}

const partnerOf = (contactId) => household(contactId).find((c) => c.id !== Number(contactId)) || null;

// "Mia & Tom Jones" when they share a surname, else "Mia Jones & Tom Smith".
function jointName(contacts) {
  const list = contacts.filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return [list[0].first_name, list[0].last_name].filter(Boolean).join(' ');
  const surnames = new Set(list.map((c) => (c.last_name || '').trim().toLowerCase()));
  if (surnames.size === 1 && list[0].last_name) return `${joinWords(list.map((c) => c.first_name), ' & ')} ${list[0].last_name}`;
  return joinWords(list.map((c) => [c.first_name, c.last_name].filter(Boolean).join(' ')), ' & ');
}

// "Mia and Tom", "Mia, Tom and Ava".
function joinWords(words, last = ' and ') {
  const w = words.filter(Boolean);
  if (w.length <= 1) return w[0] || '';
  return `${w.slice(0, -1).join(', ')}${last}${w[w.length - 1]}`;
}

// Keeps a household's address in step: when one person's address changes,
// partners who lived at the same old address move with them.
function syncAddress(contactId, before, after) {
  const changed = ADDRESS.some((k) => (after[k] ?? before[k]) !== before[k]);
  if (!changed) return 0;
  let moved = 0;
  for (const id of householdIds(contactId)) {
    if (id === Number(contactId)) continue;
    const p = db.one('SELECT * FROM contacts WHERE id = ?', id);
    if (ADDRESS.every((k) => (p[k] || '') === (before[k] || ''))) {
      db.update('contacts', id, { ...Object.fromEntries(ADDRESS.map((k) => [k, after[k] !== undefined ? after[k] : before[k]])), updated_at: nowIso() });
      moved++;
    }
  }
  return moved;
}

module.exports = {
  ENTITY_ROLES, TYPES, link, update, unlink, relatedTo, householdIds, household, partnerOf, jointName, joinWords, syncAddress, fillAddress };
