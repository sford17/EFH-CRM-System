'use strict';
const db = require('../db');
const { money, formatDate, stageLabel, today } = require('../util');

const FILTERS = {
  money,
  date: formatDate,
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  pct: (v) => (v === null || v === undefined || v === '' ? '' : `${Number(v).toFixed(2)}%`),
};

function lookup(ctx, pathStr) {
  return pathStr.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), ctx);
}

// Replaces {{ path.to.value }} and {{ path | filter }} placeholders.
function render(template, ctx) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_, p, filter) => {
    const value = lookup(ctx, p);
    if (filter && FILTERS[filter]) return FILTERS[filter](value);
    return value === null || value === undefined ? '' : String(value);
  });
}

function lvr(deal) {
  if (!deal || !deal.loan_amount || !deal.property_value) return null;
  return Math.round((deal.loan_amount / deal.property_value) * 10000) / 100;
}

// Assembles the merge-field context for a contact and/or deal.
function buildContext({ contactId, dealId, userId } = {}) {
  let deal = null;
  if (dealId) {
    deal = db.one(
      `SELECT d.*, l.name AS lender_name FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.id = ?`,
      dealId,
    );
    if (deal) {
      deal.stage_label = stageLabel(deal.stage);
      deal.lvr = lvr(deal);
      deal.outstanding_documents = db
        .all("SELECT name FROM documents WHERE deal_id = ? AND status IN ('required','requested') ORDER BY category, name", dealId)
        .map((d) => `  - ${d.name}`)
        .join('\n');
      contactId = contactId || deal.contact_id;
    }
  }
  const contact = contactId ? db.one('SELECT * FROM contacts WHERE id = ?', contactId) : null;
  if (contact) contact.full_name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const brokerId = userId || deal?.owner_id || contact?.owner_id;
  const broker = brokerId ? db.one('SELECT id, name, email, phone FROM users WHERE id = ?', brokerId) : null;
  return {
    contact,
    deal,
    broker: broker || { name: db.getSetting('business_name', 'Your broker'), email: '', phone: '' },
    business: {
      name: db.getSetting('business_name', 'EFH Mortgage Broking'),
      phone: db.getSetting('business_phone', ''),
      email: db.getSetting('business_email', ''),
      website: db.getSetting('business_website', ''),
    },
    today: today(),
  };
}

module.exports = { render, buildContext, lvr };
