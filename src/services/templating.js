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

// The broker's Calendly link, pre-filled for this contact when there is one.
function bookingLinkFor(userId, contact) {
  const account = db.one('SELECT scheduling_url FROM calendly_accounts WHERE user_id = ? AND connected = 1', userId);
  if (!account?.scheduling_url) return '';
  return require('./calendly').bookingLink(account.scheduling_url, contact);
}

// Assembles the merge-field context for a contact and/or deal.
function buildContext({ contactId, dealId, userId, loanId, latestDeal = false, addresseeIds = null, recipientRole = null } = {}) {
  let loan = null;
  if (loanId) {
    loan = db.one(
      `SELECT n.*, COALESCE(l.name, n.lender_name) AS lender_name FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id WHERE n.id = ?`,
      loanId,
    );
    if (loan) {
      contactId = contactId || loan.contact_id;
      dealId = dealId || loan.deal_id;
    }
  }
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
  // Sent from a contact rather than a deal: use their most recent loan so
  // fields like {{deal.lender_name}} still fill in.
  if (!deal && contactId && latestDeal) {
    const latest = db.one(
      `SELECT id FROM deals WHERE contact_id = ? OR co_borrower_id = ?
       ORDER BY stage = 'lost', updated_at DESC LIMIT 1`,
      contactId, contactId,
    );
    if (latest) return buildContext({ contactId, dealId: latest.id, userId, loanId, latestDeal: true, addresseeIds, recipientRole });
  }
  const contact = contactId ? db.one('SELECT * FROM contacts WHERE id = ?', contactId) : null;
  // Sent by hand from a contact or deal: pick the loan the email is most
  // likely about – the deal's own loan, else the next fixed-rate expiry,
  // else the most recent active loan – so {{loan.*}} fields fill in.
  if (!loan && latestDeal && contact) {
    const pickId = (deal && db.one('SELECT id FROM loans WHERE deal_id = ?', deal.id)?.id)
      ?? db.one(
        `SELECT id FROM loans WHERE (contact_id = ? OR co_borrower_id = ?) AND status = 'active'
         ORDER BY (rate_type != 'variable' AND fixed_expiry_date >= date('now')) DESC, fixed_expiry_date, id DESC LIMIT 1`,
        contact.id, contact.id,
      )?.id;
    if (pickId) {
      loan = db.one('SELECT n.*, COALESCE(l.name, n.lender_name) AS lender_name FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id WHERE n.id = ?', pickId);
    }
  }
  if (contact) contact.full_name = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  // Addressed to more than one person (e.g. a couple): names read "Mia and
  // Tom" in templates, and the email goes to everyone listed.
  let addressees = contact ? [contact] : [];
  const household = require('./household');
  if (!Array.isArray(addresseeIds)) addresseeIds = null;
  // Only the contact's household or the co-borrower on this deal/loan.
  const allowed = new Set(contact && addresseeIds?.length
    ? [...household.householdIds(contact.id), deal?.co_borrower_id, deal?.contact_id, loan?.co_borrower_id, loan?.contact_id].filter(Boolean)
    : []);
  const extra = [...new Set((addresseeIds || []).map(Number))].filter((id) => id !== contact?.id && allowed.has(id));
  if (contact && extra.length) {
    const others = extra.map((id) => db.one('SELECT * FROM contacts WHERE id = ?', id)).filter(Boolean);
    addressees = [contact, ...others];
    contact.single_first_name = contact.first_name;
    contact.first_name = household.joinWords(addressees.map((c) => c.first_name));
    contact.full_name = household.jointName(addressees);
  }
  const brokerId = userId || deal?.owner_id || contact?.owner_id;
  const broker = brokerId ? db.one('SELECT id, name, email, phone FROM users WHERE id = ?', brokerId) : null;
  // The agent, solicitor etc. on the deal: {{agent.name}}, {{solicitor.email}}…
  // and {{recipient.*}} when the email is going to one of them.
  const parties = deal ? require('./parties').forContext(deal.id) : {};
  // Who referred the client (the deal's referral partner, else the contact's).
  const referrerId = deal?.referral_partner_id || contact?.referral_partner_id || null;
  const referrerRow = referrerId ? db.one('SELECT id, name, company, email, phone, mobile FROM referral_partners WHERE id = ?', referrerId) : null;
  const referrer = referrerRow ? { ...referrerRow, first_name: String(referrerRow.name).split(/\s+/)[0] } : {};
  return {
    contact,
    addressees,
    parties,
    agent: parties.real_estate_agent || {},
    solicitor: parties.solicitor || {},
    buyers_agent: parties.buyers_agent || {},
    referrer,
    recipient: (recipientRole && Object.hasOwn(parties, recipientRole) && parties[recipientRole]) || {},
    deal,
    loan,
    broker: broker
      ? {
        ...broker,
        first_name: String(broker.name || '').split(' ')[0],
        booking_link: bookingLinkFor(broker.id, contact),
      }
      : { name: db.getSetting('business_name', 'Your broker'), first_name: db.getSetting('business_name', 'Your broker'), email: '', phone: '' },
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
