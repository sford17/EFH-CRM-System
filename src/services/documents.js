'use strict';
const db = require('../db');
const { DOCUMENT_CHECKLIST } = require('../constants');

// Adds the standard checklist for the deal's loan purpose (idempotent).
function createChecklist(dealId) {
  const deal = db.one(
    'SELECT d.loan_purpose, c.employment_type FROM deals d JOIN contacts c ON c.id = d.contact_id WHERE d.id = ?',
    dealId,
  );
  if (!deal) return 0;
  const items = [
    ...DOCUMENT_CHECKLIST['*'],
    ...(DOCUMENT_CHECKLIST[deal.loan_purpose] || []),
    ...(deal.employment_type === 'self_employed' ? DOCUMENT_CHECKLIST.self_employed : []),
  ];
  let added = 0;
  for (const [name, category] of items) {
    added += Number(db.run('INSERT OR IGNORE INTO documents (deal_id, name, category) VALUES (?, ?, ?)', dealId, name, category).changes);
  }
  return added;
}

function outstanding(dealId) {
  return db.all("SELECT * FROM documents WHERE deal_id = ? AND status IN ('required','requested') ORDER BY category, name", dealId);
}

module.exports = { createChecklist, outstanding };
