'use strict';
// Mortgage tracker: a client's properties (with valuation history), loan
// facilities and what secures them, and other assets. Also builds the
// lending-structure view: per-property LVR, equity and usable equity.
const db = require('../db');
const { today, nowIso, addMonths } = require('../util');

// Each kind of valuation, with a plain-English description for clients (shown under reports that use it).
const VALUATION_METHODS = [
  { key: 'full', label: 'Full valuation', description: 'A qualified valuer inspects the property inside and out and compares it with recent nearby sales. The most thorough type, and the one lenders rely on most.' },
  { key: 'desktop', label: 'Desktop valuation', description: 'A valuer assesses the property from their desk, using recent sales, property records and market data, without visiting. Quicker than a full valuation, but less precise.' },
  { key: 'kerbside', label: 'Kerbside valuation', description: 'A valuer views the property from the street, without going inside, and combines this with sales data. More detailed than a desktop valuation, less than a full one.' },
  { key: 'avm', label: 'AVM', description: 'An automated valuation model: a computer-generated estimate based on sales data and property details. Instant, but it can\'t see a property\'s condition, renovations or special features.' },
  { key: 'contract_price', label: 'Contract price', description: 'The price agreed on the contract of sale when the property was bought. It reflects the market at that time.' },
  { key: 'agent_appraisal', label: 'Agent appraisal', description: 'A real estate agent\'s opinion of what the property could sell for, based on their local knowledge. A useful guide, but not a formal valuation.' },
  { key: 'client_estimate', label: 'Client estimate', description: 'The owner\'s own estimate of what the property is worth. A helpful starting point that hasn\'t been independently checked.' },
  { key: 'other', label: 'Other', description: 'A value from another source, as noted.' },
];
const PURCHASE_PRICE = { key: 'purchase_price', label: 'Purchase price', description: 'What was paid for the property when it was bought.' };

// [label, description] for the valuation types mentioned (by key or label), in a fixed order.
function valuationGlossary(mentioned) {
  const seen = new Set([...mentioned].filter(Boolean).map((m) => String(m).toLowerCase()));
  return [...VALUATION_METHODS, PURCHASE_PRICE]
    .filter((m) => seen.has(m.key) || seen.has(m.label.toLowerCase()))
    .map((m) => [m.label, m.description]);
}
const USABLE_EQUITY_LVR = 0.8;
const PURCHASE_PURPOSES = ['purchase', 'first_home', 'investment', 'construction'];

const normAddress = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Copies a settled deal into the tracker: its loan, the security property and
// the value recorded on the deal. Safe to call more than once.
function createFromDeal(dealId, { importId = null } = {}) {
  const existing = db.one('SELECT id FROM loans WHERE deal_id = ?', dealId);
  if (existing) return existing.id;
  const deal = db.one('SELECT * FROM deals WHERE id = ?', dealId);
  if (!deal) return null;

  let propertyId = null;
  if (deal.property_address) {
    const match = db.all('SELECT id, address FROM properties WHERE contact_id = ?', deal.contact_id)
      .find((p) => normAddress(p.address) === normAddress(deal.property_address));
    const isPurchase = PURCHASE_PURPOSES.includes(deal.loan_purpose);
    propertyId = match?.id ?? db.insert('properties', {
      contact_id: deal.contact_id,
      co_owner_id: deal.co_borrower_id,
      address: deal.property_address,
      usage: deal.loan_purpose === 'investment' ? 'investment' : 'owner_occupied',
      purchase_date: isPurchase ? deal.settlement_date : null,
      purchase_price: isPurchase ? deal.property_value : null,
      deal_id: deal.id,
      import_id: importId,
    });
    if (!match && deal.property_value) {
      db.insert('valuations', {
        property_id: propertyId,
        valuation_date: deal.settlement_date || today(),
        amount: deal.property_value,
        method: isPurchase ? 'contract_price' : 'other',
        lender_id: deal.lender_id,
        notes: `Value recorded on deal "${deal.title}"`,
      });
    }
  }

  const loanId = db.insert('loans', {
    contact_id: deal.contact_id,
    co_borrower_id: deal.co_borrower_id,
    deal_id: deal.id,
    lender_id: deal.lender_id,
    loan_type: deal.loan_type && deal.loan_type !== 'other' ? deal.loan_type
      : deal.loan_purpose === 'investment' ? 'investment_loan'
      : deal.loan_purpose === 'construction' ? 'construction'
        : deal.loan_purpose === 'commercial' ? 'commercial'
          : deal.loan_purpose === 'business_loan' ? 'business_loan' : 'home_loan',
    account_number: deal.application_ref,
    product_name: deal.product_name,
    limit_amount: deal.loan_amount,
    balance: deal.loan_amount,
    balance_date: deal.settlement_date,
    interest_rate: deal.interest_rate,
    rate_type: deal.rate_type || 'variable',
    fixed_expiry_date: deal.fixed_expiry_date,
    repayment_type: deal.repayment_type || 'pi',
    settlement_date: deal.settlement_date,
    loan_term_years: deal.loan_term_years,
  });
  if (propertyId) db.run('INSERT OR IGNORE INTO loan_securities (loan_id, property_id) VALUES (?, ?)', loanId, propertyId);
  // Everyone on the deal is on the loan.
  require('./borrowers').setCo('loan', loanId, require('./borrowers').coIds('deal', deal.id));
  return loanId;
}

// ---- Reading a client's position -------------------------------------------------

const methodLabel = (key) => VALUATION_METHODS.find((m) => m.key === key)?.label || key;

const inList = (ids) => ids.map(() => '?').join(',');

function propertiesFor(ids) {
  const rules = valuationRules();
  const props = db.all(
    `SELECT p.*, o.first_name || ' ' || COALESCE(o.last_name,'') AS co_owner_name, w.first_name || ' ' || COALESCE(w.last_name,'') AS owner_name
     FROM properties p LEFT JOIN contacts o ON o.id = p.co_owner_id LEFT JOIN contacts w ON w.id = p.contact_id
     WHERE p.contact_id IN (${inList(ids)}) OR p.co_owner_id IN (${inList(ids)}) ORDER BY p.status = 'sold', p.id`,
    ...ids, ...ids,
  );
  for (const p of props) {
    p.valuations = db.all(
      `SELECT v.*, l.name AS lender_name FROM valuations v LEFT JOIN lenders l ON l.id = v.lender_id
       WHERE v.property_id = ? ORDER BY v.valuation_date DESC, v.id DESC`,
      p.id,
    );
    // Change versus the previous valuation (any method).
    p.valuations.forEach((v, i) => {
      const prev = p.valuations[i + 1];
      v.method_label = methodLabel(v.method);
      v.change = prev ? v.amount - prev.amount : null;
      v.change_pct = prev && prev.amount ? Math.round(((v.amount - prev.amount) / prev.amount) * 1000) / 10 : null;
    });
    // Most recent figure from each method, for side-by-side comparison.
    const latest = new Map();
    for (const v of p.valuations) if (!latest.has(v.method)) latest.set(v.method, v);
    p.latest_by_method = [...latest.values()];
    const chosen = chooseValuation(p, rules);
    p.current_valuation = chosen.valuation;
    p.current_value = chosen.valuation?.amount ?? p.purchase_price ?? null;
    p.valuation_basis = chosen.basis;
  }
  return props;
}

// How a property's value is chosen (Settings → Property valuations).
function valuationRules() {
  const months = Number(db.getSetting('valuation_recent_months', '12'));
  return {
    rule: db.getSetting('valuation_rule', 'highest_recent') === 'latest' ? 'latest' : 'highest_recent',
    months: Number.isFinite(months) && months >= 0 ? months : 12,
    ignoreEstimates: db.getSetting('valuation_ignore_estimates', '1') !== '0',
  };
}

// The valuation a property's value (and so its LVR and equity) is based on:
// one the broker has chosen; otherwise the highest of the latest valuation of
// each method (full, desktop, kerbside, AVM…) dated within `months` of the
// newest one; or simply the newest, if that's the setting. Client estimates
// only count when there's nothing else (unless the setting says otherwise).
function chooseValuation(p, rules = valuationRules()) {
  const vals = p.valuations;
  if (!vals.length) {
    return { valuation: null, basis: p.purchase_price ? { type: 'purchase_price', note: 'Purchase price (no valuations yet)' } : null };
  }
  const pinned = p.valuation_id && vals.find((v) => v.id === p.valuation_id);
  if (pinned) return { valuation: pinned, basis: { type: 'chosen', note: 'Chosen by you', compared_ids: [pinned.id] } };
  if (rules.rule === 'latest') return { valuation: vals[0], basis: { type: 'latest', note: 'Most recent valuation', compared_ids: [vals[0].id] } };

  let candidates = p.latest_by_method;
  if (rules.ignoreEstimates && candidates.some((v) => v.method !== 'client_estimate')) candidates = candidates.filter((v) => v.method !== 'client_estimate');
  const newest = candidates.reduce((m, v) => (v.valuation_date && v.valuation_date > m ? v.valuation_date : m), '');
  if (rules.months > 0 && newest) {
    const from = addMonths(newest, -rules.months);
    candidates = candidates.filter((v) => (v.valuation_date || '') >= from);
  }
  const best = candidates.reduce((b, v) => (!b || v.amount > b.amount || (v.amount === b.amount && v.valuation_date > b.valuation_date) ? v : b), null);
  const window = rules.months > 0 ? ` (within ${rules.months} month${rules.months === 1 ? '' : 's'} of the newest)` : '';
  const note = candidates.length > 1
    ? `Highest of ${candidates.length} recent valuations: ${candidates.map((v) => v.method_label).join(', ')}${window}`
    : 'Most recent valuation';
  return { valuation: best, basis: { type: 'highest_recent', note, compared_ids: candidates.map((v) => v.id) } };
}

function loansFor(ids) {
  const loans = db.all(
    `SELECT n.*, COALESCE(l.name, n.lender_name, 'Unknown lender') AS lender_display, l.logo_asset_id AS lender_logo_id,
            ${require('./borrowers').coNamesSql('loan', 'n')} AS co_borrower_name, m.first_name || ' ' || COALESCE(m.last_name,'') AS borrower_name
     FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id
     LEFT JOIN contacts m ON m.id = n.contact_id
     WHERE ${require('./borrowers').involving('loan', 'n', ids)}
     ORDER BY n.status != 'active', lender_display, n.id`,
    ...ids, ...ids,
  );
  for (const n of loans) {
    n.security_ids = db.all('SELECT property_id FROM loan_securities WHERE loan_id = ?', n.id).map((r) => r.property_id);
    n.owing = n.balance ?? n.limit_amount ?? 0;
    n.net_owing = Math.max(0, n.owing - (n.offset_balance || 0));
  }
  return loans;
}

const assetsFor = (ids) => db.all(
  `SELECT a.*, c.first_name AS owner_first_name FROM client_assets a JOIN contacts c ON c.id = a.contact_id
   WHERE a.contact_id IN (${inList(ids)}) ORDER BY a.asset_type, a.id`,
  ...ids,
);

// Spreads each loan's balance over the properties securing it (by value), so
// each property gets an LVR even when loans are cross-collateralised.
function structure(properties, loans) {
  const active = loans.filter((n) => n.status === 'active');
  const owned = properties.filter((p) => p.status !== 'sold');
  const byId = new Map(owned.map((p) => [p.id, { ...p, secured_debt: 0, lenders: new Set(), loan_ids: [] }]));

  for (const n of active) {
    const secured = n.security_ids.map((id) => byId.get(id)).filter(Boolean);
    if (!secured.length) continue;
    const total = secured.reduce((s, p) => s + (p.current_value || 0), 0);
    for (const p of secured) {
      const share = total > 0 ? (p.current_value || 0) / total : 1 / secured.length;
      p.secured_debt += n.owing * share;
      p.lenders.add(n.lender_display);
      p.loan_ids.push(n.id);
    }
  }

  const props = [...byId.values()].map((p) => {
    const value = p.current_value || 0;
    const lvr = value ? Math.round((p.secured_debt / value) * 1000) / 10 : null;
    return {
      ...p,
      lenders: [...p.lenders],
      secured_debt: Math.round(p.secured_debt),
      lvr,
      equity: value ? Math.round(value - p.secured_debt) : null,
      usable_equity: value ? Math.max(0, Math.round(value * USABLE_EQUITY_LVR - p.secured_debt)) : null,
      multiple_lenders: p.lenders.size > 1,
    };
  });

  const propertyValue = props.reduce((s, p) => s + (p.current_value || 0), 0);
  const securedDebt = active.filter((n) => n.security_ids.length).reduce((s, n) => s + n.owing, 0);
  const unsecuredDebt = active.filter((n) => !n.security_ids.length).reduce((s, n) => s + n.owing, 0);
  const offsets = active.reduce((s, n) => s + (n.offset_balance || 0), 0);

  const groups = new Map();
  for (const n of active) {
    if (!groups.has(n.lender_display)) groups.set(n.lender_display, []);
    groups.get(n.lender_display).push({
      ...n,
      cross_collateralised: n.security_ids.length > 1,
      unsecured: n.security_ids.length === 0,
    });
  }
  return {
    lenders: [...groups.entries()].map(([name, list]) => ({
      name, logo_id: list.find((n) => n.lender_logo_id)?.lender_logo_id ?? null, loans: list, total: list.reduce((s, n) => s + n.owing, 0),
    })),
    properties: props,
    totals: {
      property_value: propertyValue,
      secured_debt: securedDebt,
      unsecured_debt: unsecuredDebt,
      total_debt: securedDebt + unsecuredDebt,
      offsets,
      lvr: propertyValue ? Math.round((securedDebt / propertyValue) * 1000) / 10 : null,
      equity: propertyValue - securedDebt,
      usable_equity: props.reduce((s, p) => s + (p.usable_equity || 0), 0),
    },
    warnings: [
      ...active.filter((n) => n.security_ids.length > 1).map((n) => `${n.lender_display} loan${n.account_number ? ` ${n.account_number}` : ''} is cross-collateralised over ${n.security_ids.length} properties`),
      ...props.filter((p) => p.multiple_lenders).map((p) => `${p.address} secures loans with more than one lender`),
      ...props.filter((p) => p.lvr > 80).map((p) => `${p.address} is at ${p.lvr}% LVR`),
      ...props.filter((p) => !p.current_value && p.loan_ids.length).map((p) => `${p.address} has no valuation`),
    ],
  };
}

// The whole household's position: contacts who share finances see one
// combined tracker.
function summary(contactId) {
  const household = require('./household');
  const members = household.household(contactId);
  const ids = members.map((m) => m.id);
  const properties = propertiesFor(ids);
  const loans = loansFor(ids);
  const assets = assetsFor(ids);
  const s = structure(properties, loans);
  const otherAssets = assets.reduce((sum, a) => sum + (a.value || 0), 0);
  return {
    household: members.map((m) => ({ id: m.id, first_name: m.first_name, last_name: m.last_name, email: m.email })),
    household_name: household.jointName(members),
    properties,
    loans,
    assets,
    structure: s,
    totals: {
      ...s.totals,
      other_assets: otherAssets,
      total_assets: s.totals.property_value + otherAssets + s.totals.offsets,
      net_position: s.totals.property_value + otherAssets + s.totals.offsets - s.totals.total_debt,
    },
    valuation_methods: VALUATION_METHODS,
  };
}

function touch(table, id) {
  db.run(`UPDATE ${table} SET updated_at = ? WHERE id = ?`, nowIso(), id);
}

module.exports = { createFromDeal, summary, structure, chooseValuation, valuationRules, VALUATION_METHODS, methodLabel, valuationGlossary, touch };
