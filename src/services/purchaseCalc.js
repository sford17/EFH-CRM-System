'use strict';
// Purchase calculation: how much the client needs to put in. Purchase price,
// loan (and LVR), then costs: the deposit, stamp duty, LMI, legal costs and
// anything else, adding up to the total contribution. Stamp duty and LMI are
// estimated automatically but can be overridden.
const stampDuty = require('./stampDuty');

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/[$,\s%]/g, '')));
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const PROPERTY_TYPES = { established: 'Established home', new: 'New home', off_the_plan: 'Off-the-plan', land: 'Vacant land', commercial: 'Commercial' };
const DEFAULT_LEGAL = 2000;
const MAX_OTHER = 12;

// Indicative LMI premium as a % of the loan, by LVR band (shared with the
// LVR calculator). Real premiums vary by insurer, loan size and borrower.
const LMI_BANDS = [[80, 0], [85, 0.75], [90, 1.6], [95, 3.2]];
function lmiEstimate(loan, value) {
  const ratio = (loan / value) * 100;
  const band = LMI_BANDS.find(([max]) => ratio <= max + 1e-9);
  return band ? round((loan * band[1]) / 100, 0) : null;
}

function money(v, label, { required = false, allowZero = true } = {}) {
  const n = num(v);
  if (n === null) {
    if (required) throw new Error(`Enter the ${label}`);
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Error(`The ${label} must be a positive number`);
  if (n > 100000000) throw new Error(`The ${label} is too large`);
  return n;
}

// Other costs can be negative, for credits such as a first home owner grant.
function otherAmount(v) {
  const n = num(v);
  if (n === null) return 0;
  if (!Number.isFinite(n) || Math.abs(n) > 100000000) throw new Error('Other costs must be amounts in dollars');
  return n;
}

// Cleans the inputs (also what's saved on a deal).
function normalise(input = {}) {
  const price = money(input.purchase_price, 'purchase price', { required: true, allowZero: false });
  const basis = input.loan_basis === 'lvr' ? 'lvr' : 'amount';
  let lvr = num(input.lvr);
  if (lvr !== null && (!Number.isFinite(lvr) || lvr < 0 || lvr > 200)) throw new Error('The LVR must be between 0% and 200%');
  let loan = money(input.loan_amount, 'loan amount');
  if (basis === 'lvr' && lvr !== null) loan = Math.round((price * lvr) / 100);
  if (loan === null && lvr !== null) loan = Math.round((price * lvr) / 100);
  if (loan === null) throw new Error('Enter the loan amount or the LVR');
  lvr = round((loan / price) * 100);
  const state = STATES.includes(String(input.state || '').toUpperCase()) ? String(input.state).toUpperCase() : 'NSW';
  const others = Array.isArray(input.other_costs) ? input.other_costs : [];
  if (others.length > MAX_OTHER) throw new Error(`Add up to ${MAX_OTHER} other costs`);
  return {
    purchase_price: price,
    loan_basis: basis,
    loan_amount: loan,
    lvr,
    state,
    property_type: Object.hasOwn(PROPERTY_TYPES, input.property_type) ? input.property_type : 'established',
    buyer: input.buyer === 'investor' ? 'investor' : 'owner',
    first_home: truthy(input.first_home),
    foreign: truthy(input.foreign),
    stamp_duty: money(input.stamp_duty, 'stamp duty'),
    lmi: money(input.lmi, 'LMI fee'),
    lmi_capitalised: truthy(input.lmi_capitalised),
    legal_costs: input.legal_costs === undefined ? DEFAULT_LEGAL : money(input.legal_costs, 'legal costs') ?? 0,
    other_costs: others.map((c) => ({
      label: String(c?.label || '').trim().slice(0, 80) || 'Other cost',
      amount: otherAmount(c?.amount),
    })),
    funds_available: money(input.funds_available, 'funds available'),
  };
}

function calculate(input) {
  const i = normalise(input);
  const warnings = [];
  const notes = [];

  // Stamp duty: estimated from the state and buyer, unless typed in.
  let duty = null;
  try {
    duty = i.property_type === 'commercial'
      ? stampDuty.commercial({ state: i.state, property_value: i.purchase_price }, { compare: false })
      : stampDuty.residential({
        state: i.state, property_value: i.purchase_price, property_type: i.property_type,
        buyer: i.buyer, first_home: i.first_home, foreign: i.foreign,
      }, { compare: false });
  } catch {
    duty = null;
  }
  const dutyAuto = duty ? duty.total : 0;
  const dutyAmount = i.stamp_duty ?? dutyAuto;
  const dutyLabel = duty ? [duty.state_name, ...(duty.concessions || []).map((c) => c.label), duty.foreign_surcharge ? 'incl. foreign surcharge' : null].filter(Boolean).join(' · ') : '';

  // LMI: indicative premium when the LVR is over 80%, unless typed in.
  const lmiAuto = lmiEstimate(i.loan_amount, i.purchase_price);
  const lmiAmount = i.lmi ?? lmiAuto ?? 0;
  if (lmiAuto === null && i.lmi === null) warnings.push('The LVR is over 95%. Most lenders won\'t lend this much without a guarantor, so no LMI estimate is shown. Enter a quote if you have one.');
  const lmiPayable = i.lmi_capitalised ? 0 : lmiAmount;
  const totalLoan = i.loan_amount + (i.lmi_capitalised ? lmiAmount : 0);

  const deposit = i.purchase_price - i.loan_amount;
  if (deposit < 0) warnings.push('The loan is more than the purchase price, so no deposit is needed. Check the loan amount.');
  const otherTotal = i.other_costs.reduce((s, c) => s + c.amount, 0);
  const costs = dutyAmount + lmiPayable + i.legal_costs + otherTotal;
  const total = Math.max(0, deposit) + costs;
  if (i.lvr > 80 && !lmiAmount && i.lmi !== null) notes.push('LMI is set to $0. That\'s right if the client is exempt (e.g. a professional package or the Home Guarantee Scheme).');
  if (i.stamp_duty === null && duty?.verify?.length) notes.push(`Stamp duty: please confirm ${duty.verify.join('; ')} on the official calculator.`);

  return {
    inputs: i,
    purchase_price: i.purchase_price,
    loan_amount: i.loan_amount,
    lvr: i.lvr,
    lmi_required: i.lvr > 80,
    total_loan: round(totalLoan),
    lvr_incl_lmi: round((totalLoan / i.purchase_price) * 100),
    deposit_required: round(Math.max(0, deposit)),
    deposit_pct: round((Math.max(0, deposit) / i.purchase_price) * 100),
    stamp_duty: { amount: round(dutyAmount), auto_amount: round(dutyAuto), overridden: i.stamp_duty !== null, label: dutyLabel, calculator: duty?.calculator || null },
    lmi: { amount: round(lmiAmount), auto_amount: lmiAuto, overridden: i.lmi !== null, capitalised: i.lmi_capitalised, payable: round(lmiPayable) },
    legal_costs: round(i.legal_costs),
    other_costs: i.other_costs,
    costs_total: round(costs),
    total_contribution: round(total),
    funds_available: i.funds_available,
    surplus: i.funds_available === null ? null : round(i.funds_available - total),
    max_loan_without_lmi: Math.floor(i.purchase_price * 0.8),
    warnings,
    notes,
  };
}

// Starting inputs for a deal that has no saved calculation yet.
const PURCHASE_PURPOSES = ['purchase', 'first_home', 'investment', 'construction', 'commercial'];
function fromDeal(deal) {
  const state = String(deal.property_address || '').toUpperCase().match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/)?.[1] || 'NSW';
  return {
    purchase_price: deal.property_value || null,
    loan_basis: 'amount',
    loan_amount: deal.loan_amount || (deal.property_value ? Math.round(deal.property_value * 0.8) : null),
    state,
    property_type: deal.loan_purpose === 'construction' ? 'land' : deal.loan_purpose === 'commercial' ? 'commercial' : 'established',
    buyer: deal.loan_purpose === 'investment' ? 'investor' : 'owner',
    first_home: deal.loan_purpose === 'first_home',
    foreign: false,
    stamp_duty: null,
    lmi: null,
    lmi_capitalised: false,
    legal_costs: DEFAULT_LEGAL,
    other_costs: [],
    funds_available: null,
  };
}

module.exports = { calculate, normalise, fromDeal, lmiEstimate, LMI_BANDS, PURCHASE_PURPOSES, PROPERTY_TYPES };
