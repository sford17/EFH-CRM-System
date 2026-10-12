'use strict';
// Transfer (stamp) duty rates by state and territory, for contracts from
// 1 July 2026 (2026-27). NSW and the ACT change their figures every 1 July,
// and every state adjusts concessions in its budget, so review these each
// July. Items marked `verify` couldn't be confirmed against the official
// calculator when this was written and are flagged to the broker on screen.
//
// Brackets: { from, base, rate } = base + rate per $100 of value over `from`;
// `whole: true` = rate per $100 on the whole value; `formula` = a function.
// `part: true` on a state = "per $100 or part of $100" (round the excess up).

const RATES_AS_AT = '2026-07-01';
const RATES_LABEL = 'Rates for contracts from 1 July 2026 (2026-27)';

const STATES = {
  NSW: {
    name: 'New South Wales',
    calculator: 'https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/transfer-duty',
    part: true,
    minimum: 20,
    general: [
      { from: 0, base: 0, rate: 1.25 }, { from: 18000, base: 225, rate: 1.5 }, { from: 38000, base: 525, rate: 1.75 },
      { from: 103000, base: 1662, rate: 3.5 }, { from: 387000, base: 11602, rate: 4.5 }, { from: 1290000, base: 52237, rate: 5.5 },
    ],
    // Premium property duty: residential land only.
    residentialTop: { from: 3870000, base: 194137, rate: 7 },
    foreign: 9,
    fhb: {
      home: { exempt: 800000, cap: 1000000, method: 'linear_to_cap', verify: true },
      land: { exempt: 350000, cap: 450000, method: 'linear_to_cap', verify: true },
      note: 'First Home Buyers Assistance Scheme: must move in within 12 months and live there for 12 months; at least one buyer an Australian citizen or permanent resident who has never owned residential property in Australia.',
    },
    commercialNote: 'Commercial property uses the general rates; premium property duty (7%) applies to residential land only.',
  },
  VIC: {
    name: 'Victoria',
    calculator: 'https://www.sro.vic.gov.au/land-transfer-duty-calculator',
    general: [
      { from: 0, base: 0, rate: 1.4 }, { from: 25000, base: 350, rate: 2.4 }, { from: 130000, base: 2870, rate: 6 },
      { from: 960000, whole: true, rate: 5.5 }, { from: 2000000, base: 110000, rate: 6.5 },
    ],
    // Principal place of residence concession, for homes up to $550,000.
    ownerOccupier: {
      max: 550000,
      brackets: [{ from: 0, base: 0, rate: 1.4 }, { from: 25000, base: 350, rate: 2.4 }, { from: 130000, base: 2870, rate: 5 }, { from: 440000, base: 18370, rate: 6 }],
      label: 'Principal place of residence concession',
    },
    foreign: 8,
    fhb: {
      home: { exempt: 600000, cap: 750000, method: 'linear_own' },
      land: { exempt: 600000, cap: 750000, method: 'linear_own' },
      note: 'First home buyer duty exemption/concession: must live in the home for 12 months, moving in within 12 months.',
    },
    offThePlanNote: 'Off-the-plan apartments, units and townhouses may qualify for a concession that deducts construction costs after the contract date (temporary concession for all buyers, contracts to about April 2027). Not included in this estimate.',
    commercialNote: 'Commercial and industrial property: duty is payable on the first sale on or after 1 July 2024 (it can be paid upfront or via a government transition loan). The property then enters the Commercial and Industrial Property Tax: later sales are exempt from duty, and an annual tax of 1% of site value starts 10 years after entry. If this property has already entered the scheme, no duty is payable.',
  },
  QLD: {
    name: 'Queensland',
    calculator: 'https://qro.qld.gov.au/duties/transfer-duty/calculate/',
    part: true,
    general: [
      { from: 0, base: 0, rate: 0 }, { from: 5000, base: 0, rate: 1.5 }, { from: 75000, base: 1050, rate: 3.5 },
      { from: 540000, base: 17325, rate: 4.5 }, { from: 1000000, base: 38025, rate: 5.75 },
    ],
    ownerOccupier: {
      brackets: [{ from: 0, base: 0, rate: 1 }, { from: 350000, base: 3500, rate: 3.5 }, { from: 540000, base: 10150, rate: 4.5 }, { from: 1000000, base: 30850, rate: 5.75 }],
      label: 'Home concession rate',
      landEligible: false,
    },
    foreign: 8,
    fhb: {
      // Established homes: home-concession duty less a concession by price band.
      home: {
        method: 'table',
        table: [
          [0, 17350], [710000, 15615], [720000, 13880], [730000, 12145], [740000, 10410],
          [750000, 8675], [760000, 6940], [770000, 5205], [780000, 3470], [790000, 1735], [800000, 0],
        ],
      },
      newHome: { method: 'exempt' },
      land: { method: 'exempt' },
      note: 'First home concession: must move in within 12 months. New homes (including off-the-plan) and vacant land for a first home are fully exempt with no price cap (contracts from 1 May 2025). From 1 August 2026 the home and first home concessions are proposed to require Australian citizenship or permanent residency (check the legislation has passed).',
    },
    commercialNote: 'Commercial property uses the general rates.',
  },
  WA: {
    name: 'Western Australia',
    calculator: 'https://apps.osr.wa.gov.au/portal/0/calculators/transferduty',
    part: true,
    general: [
      { from: 0, base: 0, rate: 1.9 }, { from: 120000, base: 2280, rate: 2.85 }, { from: 150000, base: 3135, rate: 3.8 },
      { from: 360000, base: 11115, rate: 4.75 }, { from: 725000, base: 28453, rate: 5.15 },
    ],
    foreign: 7,
    fhb: {
      home: { exempt: 600000, cap: 800000, method: 'rate', rate: 16.15 },
      land: { exempt: 450000, cap: 550000, method: 'rate', rate: 20.14, verify: true },
      note: 'First home owner rate (agreements from 7 May 2026): must not have owned residential property in Australia and must move in within 12 months.',
    },
    offThePlanNote: 'Off-the-plan apartments and strata homes may qualify for an off-the-plan duty concession (up to 100% for pre-construction purchases under about $800,000). Not included in this estimate.',
    commercialNote: 'Commercial property uses the same general rates as residential (since 1 July 2022).',
  },
  SA: {
    name: 'South Australia',
    calculator: 'https://www.revenuesa.sa.gov.au/stamp-duty-land/calculate-stamp-duty',
    part: true,
    general: [
      { from: 0, base: 0, rate: 1 }, { from: 12000, base: 120, rate: 2 }, { from: 30000, base: 480, rate: 3 },
      { from: 50000, base: 1080, rate: 3.5 }, { from: 100000, base: 2830, rate: 4 }, { from: 200000, base: 6830, rate: 4.25 },
      { from: 250000, base: 8955, rate: 4.75 }, { from: 300000, base: 11330, rate: 5 }, { from: 500000, base: 21330, rate: 5.5 },
    ],
    foreign: 7,
    fhb: {
      home: { method: 'none' },
      newHome: { method: 'exempt' },
      land: { method: 'exempt' },
      note: 'First home buyer relief covers new homes, off-the-plan and vacant land to build on (no price cap); established homes pay full duty. Buyers (and their partners) must never have owned residential property and must live in the home for 6 months, starting within 12 months.',
    },
    commercialNote: 'South Australia charges no duty on transfers of commercial and industrial ("qualifying") land since 1 July 2018. Primary-production land, and vacant land zoned for a dwelling (from 15 September 2026), still pays the general rates.',
    commercialFree: true,
  },
  TAS: {
    name: 'Tasmania',
    calculator: 'https://www.sro.tas.gov.au/property-transfer-duties',
    part: true,
    general: [
      { from: 0, base: 50, rate: 0 }, { from: 3000, base: 50, rate: 1.75 }, { from: 25000, base: 435, rate: 2.25 },
      { from: 75000, base: 1560, rate: 3.5 }, { from: 200000, base: 5935, rate: 4 }, { from: 375000, base: 12935, rate: 4.25 },
      { from: 725000, base: 27810, rate: 4.5 },
    ],
    foreign: 8,
    fhb: {
      home: { method: 'none' },
      land: { method: 'none' },
      note: 'Tasmania\'s first home buyer duty exemption (established homes up to $750,000) ended for settlements after 30 June 2026, so first home buyers now pay general duty.',
    },
    commercialNote: 'Commercial property uses the same general rates.',
  },
  ACT: {
    name: 'Australian Capital Territory',
    calculator: 'https://www.revenue.act.gov.au/rates-and-property-charges/conveyance-duty-stamp-duty',
    part: true,
    // Non-owner-occupier (investor) rates.
    general: [
      { from: 0, base: 0, rate: 1.2 }, { from: 200000, base: 2400, rate: 2.2 }, { from: 300000, base: 4600, rate: 3.4 },
      { from: 500000, base: 11400, rate: 4.32 }, { from: 750000, base: 22200, rate: 5.9 }, { from: 1000000, base: 36950, rate: 6.4 },
      { from: 1455000, whole: true, rate: 4.54 },
    ],
    generalVerify: true,
    ownerOccupier: {
      brackets: [
        { from: 0, base: 0, rate: 0.28 }, { from: 260000, base: 728, rate: 2.2 }, { from: 300000, base: 1608, rate: 3.4 },
        { from: 500000, base: 8408, rate: 4.32 }, { from: 750000, base: 19208, rate: 5.9 }, { from: 1000000, base: 33958, rate: 6.4 },
        { from: 1455000, whole: true, rate: 4.54 },
      ],
      label: 'Owner-occupier rates',
      landEligible: true,
    },
    foreign: 0,
    fhb: {
      home: { method: 'exempt' },
      land: { method: 'exempt' },
      note: 'Home Buyer Concession Scheme (from 1 July 2026): no duty, with no price cap or income test, for buyers who haven\'t held an interest in land in the last 5 years and live in the home for 12 months. Not limited to first home buyers.',
    },
    offThePlanOwnerExempt: 'Off-the-plan unit duty exemption: individuals buying an off-the-plan unit to live in pay no duty (no price cap from 1 July 2026).',
    commercial: [{ from: 0, base: 0, rate: 0 }, { from: 2100000, whole: true, rate: 5 }],
    commercialNote: 'ACT commercial property: no duty up to $2,100,000; above that, 5% of the whole value (transactions from 1 July 2026).',
  },
  NT: {
    name: 'Northern Territory',
    calculator: 'https://nt.gov.au/employ/money-and-taxes/taxes-royalties-and-grants/stamp-duty',
    general: [
      { from: 0, formula: (v) => { const t = v / 1000; return 0.06571441 * t * t + 15 * t; } },
      { from: 525000, whole: true, rate: 4.95 }, { from: 3000000, whole: true, rate: 5.75 }, { from: 5000000, whole: true, rate: 5.95 },
    ],
    foreign: 0,
    fhb: {
      home: { method: 'none' },
      land: { method: 'none' },
      newHome: { method: 'exempt', anyBuyer: true },
      note: 'There is no first home buyer duty concession in the NT. The House and Land Package Exemption (all buyers, contracts to 30 June 2027) removes duty on a freestanding new home bought as one house-and-land contract from a builder, if you live in it. First home buyers of new homes may also get the $50,000 HomeGrown Territory Grant.',
    },
    seniorsNote: 'Seniors, pensioners and carers may get up to $10,000 off duty on a home up to $750,000.',
    commercialNote: 'Commercial property uses the same rates and formula.',
  },
};

module.exports = { STATES, RATES_AS_AT, RATES_LABEL };
