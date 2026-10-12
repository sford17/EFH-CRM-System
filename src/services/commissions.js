'use strict';
const db = require('../db');
const { addMonths, today } = require('../util');

const round2 = (n) => Math.round(n * 100) / 100;

// Creates expected upfront, referral fee and first-year trail entries for a
// settled deal. Safe to call repeatedly: does nothing if upfront already exists.
function generateForDeal(dealId) {
  const deal = db.one(
    `SELECT d.*, l.upfront_pct, l.trail_pct, p.referral_fee_pct, p.name AS partner_name
     FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id
     LEFT JOIN referral_partners p ON p.id = d.referral_partner_id WHERE d.id = ?`,
    dealId,
  );
  if (!deal || !deal.loan_amount || deal.upfront_pct == null) return 0;
  if (db.one("SELECT 1 FROM commissions WHERE deal_id = ? AND type = 'upfront'", dealId)) return 0;

  const settled = deal.settlement_date || today();
  const period = settled.slice(0, 7);
  const upfront = round2((deal.loan_amount * deal.upfront_pct) / 100);
  let created = 0;
  db.transaction(() => {
    db.insert('commissions', { deal_id: dealId, type: 'upfront', amount: upfront, period, notes: `${deal.upfront_pct}% of loan amount` });
    created++;
    if (deal.referral_fee_pct > 0) {
      db.insert('commissions', {
        deal_id: dealId,
        type: 'referral_fee',
        amount: -round2((upfront * deal.referral_fee_pct) / 100),
        period,
        notes: `${deal.referral_fee_pct}% of upfront to ${deal.partner_name}`,
      });
      created++;
    }
    if (deal.trail_pct > 0) {
      const monthly = round2((deal.loan_amount * deal.trail_pct) / 100 / 12);
      for (let m = 1; m <= 12; m++) {
        db.insert('commissions', { deal_id: dealId, type: 'trail', amount: monthly, period: addMonths(settled, m).slice(0, 7) });
        created++;
      }
    }
  });
  return created;
}

// Deals still inside the lender's clawback window.
function clawbackExposure(asOf = today()) {
  return db.all(
    `SELECT d.id, d.title, d.settlement_date, d.loan_amount, l.name AS lender_name, l.clawback_months,
            date(d.settlement_date, '+' || l.clawback_months || ' months') AS clawback_until,
            (SELECT COALESCE(SUM(amount),0) FROM commissions c WHERE c.deal_id = d.id AND c.type = 'upfront') AS upfront
     FROM deals d JOIN lenders l ON l.id = d.lender_id
     WHERE d.stage = 'settled' AND d.settlement_date IS NOT NULL
       AND date(d.settlement_date, '+' || l.clawback_months || ' months') >= ?
     ORDER BY clawback_until`,
    asOf,
  );
}

module.exports = { generateForDeal, clawbackExposure };
