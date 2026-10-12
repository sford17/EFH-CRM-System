'use strict';
// Stamp (transfer) duty estimates for residential and commercial purchases in
// every state and territory. Estimates only: the official calculator for the
// state is linked in every result.
const { STATES, RATES_LABEL } = require('./stampDutyRates');

const round2 = (n) => Math.round(n * 100) / 100;
const TYPES = { established: 'Established home', new: 'New home', off_the_plan: 'Off-the-plan', land: 'Vacant land' };
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

function stateOf(code) {
  const key = String(code || '').toUpperCase();
  if (!Object.hasOwn(STATES, key)) throw new Error('Choose a state or territory');
  return [key, STATES[key]];
}

function valueOf(input) {
  const v = Number(input.property_value);
  if (!Number.isFinite(v) || v <= 0) throw new Error('Enter the property value');
  if (v > 100000000) throw new Error('Enter a property value up to $100,000,000');
  return v;
}

// Duty on `value` from a bracket table. "Per $100 or part" rounds the
// excess over the band up to the next $100.
function dutyOn(brackets, value, part = false) {
  let band = brackets[0];
  for (const b of brackets) if (value > b.from || b.from === 0) band = b;
  if (band.formula) return band.formula(value);
  if (band.whole) return (value * band.rate) / 100;
  const excess = value - band.from;
  const hundreds = part ? Math.ceil(excess / 100) : excess / 100;
  return band.base + hundreds * band.rate;
}

function generalDuty(S, value, { residential }) {
  const brackets = residential && S.residentialTop ? [...S.general, S.residentialTop] : S.general;
  const duty = dutyOn(brackets, value, S.part);
  return S.minimum ? Math.max(S.minimum, duty) : duty;
}

// First home buyer exemption/concession for the property type, given the
// duty otherwise payable (after any owner-occupier rates).
function firstHome(S, type, value, current) {
  const rules = S.fhb || {};
  const rule = type === 'land' ? rules.land : (type === 'new' || type === 'off_the_plan') ? rules.newHome || rules.home : rules.home;
  if (!rule || rule.method === 'none') return null;
  const result = (duty, label) => ({ duty: Math.max(0, Math.min(current, duty)), label, verify: Boolean(rule.verify) });
  switch (rule.method) {
    case 'exempt':
      return result(0, 'First home buyer exemption');
    case 'linear_to_cap': // NSW: phases in to the full duty at the cap
      if (value <= rule.exempt) return result(0, 'First home buyer exemption');
      if (value < rule.cap) return result(generalDuty(S, rule.cap, { residential: true }) * ((value - rule.exempt) / (rule.cap - rule.exempt)), 'First home buyer concession');
      return null;
    case 'linear_own': // VIC: a sliding share of the normal duty
      if (value <= rule.exempt) return result(0, 'First home buyer exemption');
      if (value <= rule.cap) return result(current * ((value - rule.exempt) / (rule.cap - rule.exempt)), 'First home buyer concession');
      return null;
    case 'rate': // WA: a concessional rate per $100 over the exemption threshold
      if (value <= rule.exempt) return result(0, 'First home owner rate (no duty)');
      if (value <= rule.cap) return result(Math.ceil((value - rule.exempt) / 100) * rule.rate, 'First home owner rate');
      return null;
    case 'table': { // QLD: a concession amount by price band
      let concession = 0;
      for (const [from, amount] of rule.table) if (value >= from) concession = amount;
      return concession ? result(current - concession, value <= 700000 ? 'First home concession (no duty)' : 'First home concession') : null;
    }
    default:
      return null;
  }
}

function residential(input, { compare = true } = {}) {
  const [code, S] = stateOf(input.state);
  const value = valueOf(input);
  const type = Object.hasOwn(TYPES, input.property_type) ? input.property_type : 'established';
  const owner = input.buyer !== 'investor';
  const foreign = truthy(input.foreign);
  const firstHomeBuyer = truthy(input.first_home) && owner && !foreign;
  const notes = [];
  const verify = [];
  const concessions = [];

  const general = generalDuty(S, value, { residential: true });
  let duty = general;
  if (S.generalVerify) verify.push(`${S.name} investor (non-owner-occupier) rates`);

  // Owner-occupier / principal place of residence rates.
  const oo = S.ownerOccupier;
  if (owner && oo && (type !== 'land' || oo.landEligible !== false) && (!oo.max || value <= oo.max)) {
    const ooDuty = dutyOn(oo.brackets, value, S.part);
    if (ooDuty < duty) {
      concessions.push({ label: oo.label, saving: round2(duty - ooDuty) });
      duty = ooDuty;
    }
  }

  // ACT off-the-plan unit exemption for owner-occupiers.
  if (code === 'ACT' && owner && type === 'off_the_plan' && duty > 0) {
    concessions.push({ label: 'Off-the-plan unit exemption', saving: round2(duty) });
    duty = 0;
    notes.push(S.offThePlanOwnerExempt);
  }

  // First home buyers (or, in the NT, the house-and-land exemption for anyone).
  const nt = code === 'NT' && owner && type === 'new' && S.fhb.newHome?.anyBuyer;
  if ((firstHomeBuyer || nt) && duty > 0) {
    const fh = nt ? { duty: 0, label: 'House and Land Package Exemption' } : firstHome(S, type, value, duty);
    if (fh && fh.duty < duty) {
      concessions.push({ label: fh.label, saving: round2(duty - fh.duty) });
      duty = fh.duty;
      if (fh.verify) verify.push(`${S.name} first home buyer ${type === 'land' ? 'vacant land' : 'home'} concession formula`);
    } else if (firstHomeBuyer) {
      notes.push(`No first home buyer concession applies to a ${TYPES[type].toLowerCase()} at this price in ${S.name}.`);
    }
  }
  if (firstHomeBuyer || nt) notes.push(S.fhb.note);
  if (truthy(input.first_home) && !owner) notes.push('First home buyer concessions need you to live in the property, so they aren\'t applied for an investment purchase.');
  if (truthy(input.first_home) && foreign) notes.push('First home buyer concessions generally require Australian citizenship or permanent residency, so they aren\'t applied for a foreign purchaser.');
  if (type === 'off_the_plan' && S.offThePlanNote) notes.push(S.offThePlanNote);
  if (code === 'NT' && owner) notes.push(S.seniorsNote);

  const surcharge = foreign && S.foreign ? (value * S.foreign) / 100 : 0;
  if (foreign && !S.foreign) notes.push(`${S.name} has no foreign purchaser duty surcharge.`);
  const total = duty + surcharge;

  const out = {
    kind: 'residential',
    state: code,
    state_name: S.name,
    property_value: value,
    property_type: TYPES[type],
    buyer: owner ? 'Owner-occupier' : 'Investor',
    general_duty: round2(general),
    concessions,
    transfer_duty: round2(duty),
    foreign_surcharge: round2(surcharge),
    foreign_rate: foreign ? S.foreign : null,
    total: round2(total),
    effective_rate: round2((total / value) * 100),
    notes: notes.filter(Boolean),
    verify,
    rates_label: RATES_LABEL,
    calculator: S.calculator,
  };
  if (compare) {
    out.comparison = Object.keys(STATES).map((s) => {
      const r = residential({ ...input, state: s }, { compare: false });
      return { state: s, total: r.total, transfer_duty: r.transfer_duty, foreign_surcharge: r.foreign_surcharge, concession: r.concessions.length > 0 };
    });
  }
  return out;
}

function commercial(input, { compare = true } = {}) {
  const [code, S] = stateOf(input.state);
  const value = valueOf(input);
  let duty;
  if (S.commercialFree) duty = 0;
  else if (S.commercial) duty = dutyOn(S.commercial, value, S.part);
  else duty = generalDuty(S, value, { residential: false });
  const out = {
    kind: 'commercial',
    state: code,
    state_name: S.name,
    property_value: value,
    transfer_duty: round2(duty),
    total: round2(duty),
    effective_rate: round2((duty / value) * 100),
    notes: [S.commercialNote, 'Foreign purchaser surcharges apply to residential land, so they aren\'t included here. GST on the purchase (if any) isn\'t included either.'].filter(Boolean),
    verify: [],
    rates_label: RATES_LABEL,
    calculator: S.calculator,
  };
  if (compare) {
    out.comparison = Object.keys(STATES).map((s) => ({ state: s, total: commercial({ ...input, state: s }, { compare: false }).total }));
  }
  return out;
}

module.exports = { residential, commercial, dutyOn, TYPES };
