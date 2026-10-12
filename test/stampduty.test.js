'use strict';
// Worked examples from the state revenue offices' published rates (2026-27).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { residential, commercial } = require('../src/services/stampDuty');

const res = (state, value, over = {}) => residential({ state, property_value: value, buyer: 'investor', ...over }, { compare: false });
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.01, `${msg || ''} expected ${expected}, got ${actual}`);

test('NSW: general, premium residential, commercial, first home buyers, foreign', () => {
  near(res('NSW', 750000).total, 27937, '$750k');
  near(res('NSW', 800000).total, 30187, '$800k');
  near(res('NSW', 1500000).total, 63787, '$1.5m');
  near(res('NSW', 5000000).total, 273237, '$5m residential (premium rate)');
  near(commercial({ state: 'NSW', property_value: 5000000 }, { compare: false }).total, 256287, '$5m commercial (no premium rate)');
  near(res('NSW', 10000).total, 125, 'small purchase');
  near(res('NSW', 1000).total, 20, 'minimum duty');
  const fhb = (v, type = 'established') => res('NSW', v, { buyer: 'owner', first_home: true, property_type: type });
  near(fhb(800000).total, 0, 'FHB exempt to $800k');
  near(fhb(900000).total, 19593.5, 'FHB $900k: half of duty at $1m');
  near(fhb(1000000).total, 39187, 'FHB at $1m: full duty');
  near(fhb(400000, 'land').total, 14437 / 2, 'FHB vacant land halfway');
  const f = res('NSW', 750000, { foreign: true });
  near(f.foreign_surcharge, 67500);
  near(f.total, 95437);
  assert.ok(fhb(900000).verify.length, 'formula flagged for checking');
});

test('VIC: general (including the flat 5.5% band), PPR, first home buyers, foreign', () => {
  near(res('VIC', 750000).total, 40070, '$750k');
  near(res('VIC', 1500000).total, 82500, '$1.5m = 5.5% of the whole value');
  near(res('VIC', 2500000).total, 142500, '$2.5m');
  near(res('VIC', 500000, { buyer: 'owner' }).total, 21970, 'PPR $500k');
  near(res('VIC', 500000).total, 25070, 'investor $500k');
  near(res('VIC', 600000, { buyer: 'owner' }).total, 31070, 'no PPR above $550k');
  near(res('VIC', 700000, { buyer: 'owner', first_home: true }).total, 24713.33, 'FHB $700k sliding scale');
  near(res('VIC', 600000, { buyer: 'owner', first_home: true }).total, 0, 'FHB exempt to $600k');
  near(res('VIC', 750000, { foreign: true }).foreign_surcharge, 60000);
  assert.match(commercial({ state: 'VIC', property_value: 2000000 }, { compare: false }).notes[0], /Commercial and Industrial Property Tax/);
});

test('QLD: general, home concession, first home buyers', () => {
  near(res('QLD', 750000).total, 26775);
  near(res('QLD', 1500000).total, 66775);
  near(res('QLD', 750000, { buyer: 'owner' }).total, 19600, 'home concession');
  near(res('QLD', 650000, { buyer: 'owner' }).total, 15100);
  near(res('QLD', 650000).total, 22275);
  const fhb = (v, type = 'established') => res('QLD', v, { buyer: 'owner', first_home: true, property_type: type });
  near(fhb(700000).total, 0, 'nil to $700k');
  near(fhb(750000).total, 10925, '$750k: 19,600 − 8,675');
  near(fhb(730000).total, 6555, '$730k: 18,700 − 12,145');
  near(fhb(800000).total, 21850, 'no concession from $800k');
  near(fhb(1200000, 'new').total, 0, 'new homes exempt, no cap');
  near(fhb(600000, 'land').total, 0, 'vacant land exempt');
  near(res('QLD', 600000, { buyer: 'owner', property_type: 'land' }).total, res('QLD', 600000).total, 'home concession not for vacant land');
});

test('WA: general, first home owner rate', () => {
  near(res('WA', 750000).total, 29740.5);
  near(res('WA', 1500000).total, 68365.5);
  near(res('WA', 700000, { buyer: 'owner', first_home: true }).total, 16150);
  near(res('WA', 600000, { buyer: 'owner', first_home: true }).total, 0);
  near(res('WA', 750000, { foreign: true }).total, 82240.5);
  assert.ok(res('WA', 500000, { buyer: 'owner', first_home: true, property_type: 'land' }).verify.length, 'vacant land rate flagged');
});

test('SA: general, first home buyers, commercial', () => {
  near(res('SA', 500000).total, 21330);
  near(res('SA', 600000).total, 26830);
  near(res('SA', 1000000).total, 48830);
  near(res('SA', 1200000).total, 59830);
  near(res('SA', 900000, { buyer: 'owner', first_home: true, property_type: 'new' }).total, 0, 'new homes exempt, no cap');
  near(res('SA', 600000, { buyer: 'owner', first_home: true }).total, 26830, 'established homes pay full duty');
  near(commercial({ state: 'SA', property_value: 3000000 }, { compare: false }).total, 0, 'no duty on commercial land');
});

test('TAS: one scale for everything; first home exemption has ended', () => {
  near(res('TAS', 600000).total, 22497.5);
  near(res('TAS', 1200000).total, 49185);
  near(res('TAS', 2000).total, 50, 'minimum $50');
  near(res('TAS', 600000, { buyer: 'owner', first_home: true }).total, 22497.5);
  near(res('TAS', 600000, { foreign: true }).foreign_surcharge, 48000);
});

test('ACT: owner-occupier vs investor rates, Home Buyer Concession Scheme, commercial threshold', () => {
  near(res('ACT', 600000, { buyer: 'owner' }).total, 12728);
  near(res('ACT', 600000).total, 15720);
  near(res('ACT', 1200000, { buyer: 'owner' }).total, 46758);
  near(res('ACT', 1200000).total, 49750);
  near(res('ACT', 2000000).total, 90800, 'flat 4.54% of the whole value');
  near(res('ACT', 900000, { buyer: 'owner', first_home: true }).total, 0, 'HBCS: no duty, no cap');
  near(res('ACT', 700000, { buyer: 'owner', property_type: 'off_the_plan' }).total, 0, 'off-the-plan unit exemption');
  near(res('ACT', 700000, { foreign: true }).foreign_surcharge, 0, 'no foreign duty surcharge');
  near(commercial({ state: 'ACT', property_value: 2100000 }, { compare: false }).total, 0);
  near(commercial({ state: 'ACT', property_value: 2500000 }, { compare: false }).total, 125000);
});

test('NT: formula up to $525,000, flat rates above; house-and-land exemption', () => {
  near(res('NT', 500000).total, 23928.6);
  near(res('NT', 400000).total, 16514.31);
  near(res('NT', 600000).total, 29700);
  near(res('NT', 1200000).total, 59400);
  near(res('NT', 4000000).total, 230000);
  near(res('NT', 700000, { buyer: 'owner', property_type: 'new' }).total, 0, 'house-and-land exemption, any owner-occupier');
});

test('results explain themselves and compare states', () => {
  const r = residential({ state: 'NSW', property_value: 900000, buyer: 'owner', first_home: true, foreign: false });
  assert.deepEqual(r.concessions.map((c) => c.label), ['First home buyer concession']);
  near(r.concessions[0].saving, r.general_duty - r.total);
  assert.equal(r.comparison.length, 8);
  assert.match(r.rates_label, /1 July 2026/);
  assert.match(r.calculator, /^https:\/\//);
  const investorFhb = residential({ state: 'VIC', property_value: 500000, buyer: 'investor', first_home: true }, { compare: false });
  assert.ok(investorFhb.notes.some((n) => /aren't applied for an investment purchase/.test(n)));
  assert.throws(() => residential({ state: 'XX', property_value: 1 }), /state or territory/);
  assert.throws(() => residential({ state: 'NSW', property_value: 0 }), /property value/);
  assert.throws(() => residential({ state: 'constructor', property_value: 1 }), /state or territory/);
  assert.equal(commercial({ state: 'QLD', property_value: 1000000 }).comparison.length, 8);
});
