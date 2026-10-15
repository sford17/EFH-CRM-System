'use strict';
// After settlement: email a referral partner asking for a tax invoice for
// their referral fee, with the client, loan amount and fee (including GST).
const db = require('../db');
const { nowIso, HttpError } = require('../util');
const { render, buildContext } = require('./templating');

const TEMPLATE = 'Referral fee invoice request';
const GST_RATE = 0.1;
const round2 = (n) => Math.round(n * 100) / 100;
const dollars = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);

// The fee and GST: from the deal's referral fee entry, else the partner's % of the upfront commission.
function figures(deal, partner, overrideExGst = null) {
  const rows = db.all("SELECT amount FROM commissions WHERE deal_id = ? AND type = 'referral_fee' AND status != 'cancelled'", deal.id);
  let ex = overrideExGst !== null && overrideExGst !== undefined && overrideExGst !== '' ? Number(overrideExGst) : null;
  if (ex !== null && (!Number.isFinite(ex) || ex <= 0)) throw new HttpError(400, 'Enter the referral fee as a positive amount');
  if (ex === null && rows.length) ex = -rows.reduce((s, r) => s + r.amount, 0);
  if (ex === null && partner.referral_fee_pct > 0 && deal.loan_amount && deal.upfront_pct != null) {
    ex = (deal.loan_amount * deal.upfront_pct / 100) * partner.referral_fee_pct / 100;
  }
  if (!ex || ex <= 0) return null;
  ex = round2(ex);
  const gst = partner.gst_registered ? round2(ex * GST_RATE) : 0;
  const inc = round2(ex + gst);
  return {
    fee_ex_gst: ex, gst, fee_inc_gst: inc, gst_registered: Boolean(partner.gst_registered),
    fee_text: gst ? `${dollars(ex)} + GST ${dollars(gst)} = ${dollars(inc)} (including GST)` : `${dollars(ex)} (no GST: you're not registered for GST)`,
  };
}

function load(dealId) {
  const deal = db.one('SELECT d.*, l.upfront_pct FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.id = ?', dealId);
  if (!deal) throw new HttpError(404, 'Deal not found');
  const partner = deal.referral_partner_id ? db.one('SELECT * FROM referral_partners WHERE id = ?', deal.referral_partner_id) : null;
  return { deal, partner };
}

// Whether the button applies, and when an invoice was last requested (for the deal page).
function status(dealId) {
  const { deal, partner } = load(dealId);
  const fig = partner ? figures(deal, partner) : null;
  const requested = db.one("SELECT MAX(invoice_requested_at) AS at FROM commissions WHERE deal_id = ? AND type = 'referral_fee'", dealId)?.at || null;
  return {
    applies: Boolean(partner && fig && (partner.referral_fee_pct > 0 || db.one("SELECT 1 FROM commissions WHERE deal_id = ? AND type = 'referral_fee'", dealId))),
    settled: deal.stage === 'settled',
    partner: partner ? { id: partner.id, name: partner.name, company: partner.company, email: partner.email, gst_registered: Boolean(partner.gst_registered) } : null,
    figures: fig,
    requested_at: requested,
  };
}

// The email, ready to check and send. `feeExGst` lets the broker correct the amount.
function draft(dealId, { feeExGst = null } = {}) {
  const { deal, partner } = load(dealId);
  if (!partner) throw new HttpError(400, 'This deal has no referral partner');
  const fig = figures(deal, partner, feeExGst);
  if (!fig) throw new HttpError(400, `${partner.name} doesn't get a referral fee on this deal`);
  const template = db.one('SELECT subject, body FROM email_templates WHERE name = ?', TEMPLATE)
    || { subject: require('../db/migrations').REFERRAL_INVOICE_TEMPLATE[2], body: require('../db/migrations').REFERRAL_INVOICE_TEMPLATE[3] };
  const ctx = buildContext({ contactId: deal.contact_id, dealId: deal.id });
  const people = require('./borrowers').all('deal', deal.id).map((b) => b.full_name);
  ctx.referral = { ...fig, client: require('./household').joinWords(people) };
  return { to: partner.email || '', subject: render(template.subject, ctx), body: render(template.body, ctx), partner: { id: partner.id, name: partner.name, company: partner.company }, figures: fig };
}

async function send(dealId, { to, subject, body, fee_ex_gst: feeExGst = null } = {}, userId) {
  const { deal, partner } = load(dealId);
  const d = draft(dealId, { feeExGst });
  const recipient = String(to || d.to).trim();
  if (!recipient) throw new HttpError(400, `Add an email address for ${partner?.name || 'the partner'} on the Partners & agents page`);
  const mailer = require('./mailer');
  const id = mailer.queueEmail({
    to: recipient, subject: String(subject || d.subject).slice(0, 300), body: String(body || d.body),
    dealId: deal.id, partnerId: partner.id, senderUserId: userId,
  });
  await mailer.processOutbox();
  const at = nowIso();
  db.run("UPDATE commissions SET invoice_requested_at = ? WHERE deal_id = ? AND type = 'referral_fee'", at, deal.id);
  const sent = db.one('SELECT status, error FROM outbox WHERE id = ?', id);
  db.insert('activities', {
    contact_id: deal.contact_id, deal_id: deal.id, user_id: userId, type: 'email',
    body: `Referral fee invoice requested from ${partner.name}${partner.company ? ` (${partner.company})` : ''}: ${d.figures.fee_text}`,
  });
  return { outbox_id: id, status: sent.status, error: sent.error, requested_at: at };
}

module.exports = { status, draft, send, figures, TEMPLATE };
