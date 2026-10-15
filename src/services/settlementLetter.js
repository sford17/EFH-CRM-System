'use strict';
// Settlement letter: a branded summary of the client's new loan (borrowers,
// loan amount, rate, repayments, direct debit account and first repayment),
// emailed to the client with the letter attached as a PDF when the loan settles.
const db = require('../db');
const household = require('./household');
const review = require('./review');
const { today, nowIso, formatDate, HttpError } = require('../util');

const FREQ = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };
const FREQ_LABEL = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };
const PURPOSE_TYPE = { investment: 'Investment loan', construction: 'Construction loan', commercial: 'Commercial loan' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LOANS = 10;

const aud = (n) => (n === null || n === undefined || n === '' ? '–' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: Number(n) % 1 ? 2 : 0 }).format(n));
const d = (x) => (x ? formatDate(x) : '–');
const nameOf = (c) => [c?.first_name, c?.last_name].filter(Boolean).join(' ');

// ---- Details: clean what comes from the form (or the AI) -----------------------------------

function text(v, max = 200) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
}
function number(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s%]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} must be a number`);
  return n;
}
function dateOf(v, label) {
  const s = text(v, 10);
  if (!s) return null;
  if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new HttpError(400, `${label} must be a date`);
  return s;
}
const oneOf = (v, list) => (list.includes(v) ? v : null);

function clean(input = {}) {
  const loans = Array.isArray(input.loans) ? input.loans : [];
  if (loans.length > MAX_LOANS) throw new HttpError(400, `Add up to ${MAX_LOANS} loan splits`);
  const dd = input.direct_debit || {};
  const bsbDigits = String(dd.bsb || '').replace(/\D/g, '');
  if (dd.bsb && bsbDigits.length !== 6) throw new HttpError(400, 'A BSB has 6 digits');
  const acct = text(dd.account_number, 30);
  if (acct && !/^[\d\s-]+$/.test(acct)) throw new HttpError(400, 'The direct debit account number should only have numbers');
  return {
    borrowers: text(input.borrowers),
    lender_id: input.lender_id ? Number(input.lender_id) || null : null,
    lender_name: text(input.lender_name, 120),
    lender_phone: text(input.lender_phone, 40),
    settlement_date: dateOf(input.settlement_date, 'The settlement date'),
    property_address: text(input.property_address, 300),
    loans: loans.map((l, i) => {
      const n = loans.length > 1 ? ` (split ${i + 1})` : '';
      return {
        account_number: text(l.account_number, 40),
        product: text(l.product, 120),
        loan_amount: number(l.loan_amount, `The loan amount${n}`),
        interest_rate: number(l.interest_rate, `The interest rate${n}`),
        rate_type: oneOf(l.rate_type, ['variable', 'fixed']) || 'variable',
        fixed_until: dateOf(l.fixed_until, `The fixed rate end date${n}`),
        loan_term_years: number(l.loan_term_years, `The loan term${n}`),
        repayment_type: oneOf(l.repayment_type, ['pi', 'io']) || 'pi',
        io_until: dateOf(l.io_until, `The interest-only end date${n}`),
        repayment_amount: number(l.repayment_amount, `The repayment amount${n}`),
        repayment_frequency: oneOf(l.repayment_frequency, Object.keys(FREQ)) || 'monthly',
        first_repayment_date: dateOf(l.first_repayment_date, `The first repayment date${n}`),
        offset_account: text(l.offset_account, 40),
      };
    }),
    direct_debit: {
      bank: text(dd.bank, 80),
      account_name: text(dd.account_name, 120),
      bsb: bsbDigits ? `${bsbDigits.slice(0, 3)}-${bsbDigits.slice(3)}` : null,
      account_number: acct,
      show_full: Boolean(dd.show_full),
    },
    intro: text(input.intro, 3000),
    next_steps: text(input.next_steps, 3000),
    // Fields the AI wasn't sure about, shown highlighted until the broker saves.
    uncertain: Array.isArray(input.uncertain) ? input.uncertain.filter((x) => typeof x === 'string').slice(0, 50) : [],
  };
}

// What's still needed before the letter is complete.
function missing(x) {
  const out = [];
  if (!x.borrowers) out.push('Borrowers');
  if (!x.lender_name) out.push('Lender');
  if (!x.settlement_date) out.push('Settlement date');
  if (!x.loans.length) out.push('Loan details');
  x.loans.forEach((l, i) => {
    const n = x.loans.length > 1 ? ` (split ${i + 1})` : '';
    if (!l.loan_amount) out.push(`Loan amount${n}`);
    if (!l.interest_rate) out.push(`Interest rate${n}`);
    if (!l.repayment_amount) out.push(`Repayment amount${n}`);
    if (!l.first_repayment_date) out.push(`First repayment date${n}`);
  });
  if (!x.direct_debit.bsb || !x.direct_debit.account_number) out.push('Direct debit account');
  return out;
}

const totalLoan = (x) => x.loans.reduce((s, l) => s + (l.loan_amount || 0), 0);
const firstRepayment = (x) => x.loans.map((l) => l.first_repayment_date).filter(Boolean).sort()[0] || null;
const firstNames = (contacts) => household.joinWords(contacts.map((c) => c.first_name).filter(Boolean), ' & ');

function defaultTexts(lender, settlementDate, business) {
  return {
    intro: `Congratulations, your new loan${lender ? ` with ${lender}` : ''} settled${settlementDate ? ` on ${d(settlementDate)}` : ''}!\n\nThank you for trusting ${business || 'us'} with your lending. Below is a summary of your loan, your repayments and what happens next. Please keep this letter with your loan documents.`,
    next_steps: [
      '• Your lender will send your welcome pack and online banking details over the next week or two.',
      '• Make sure there are enough funds in your direct debit account the day before each repayment is due.',
      '• If you have an offset account, money you keep there reduces the interest you pay.',
      '• We\'ll check in with you each year to make sure your loan is still competitive. Call us any time if your circumstances change.',
    ].join('\n'),
  };
}

// ---- Starting point from the deal ------------------------------------------------------------

function dealFor(dealId) {
  const deal = db.one(
    `SELECT d.*, l.name AS lender_name, l.customer_phone AS lender_phone, l.logo_asset_id AS lender_logo_id, c.first_name, c.last_name, c.email AS contact_email
     FROM deals d JOIN contacts c ON c.id = d.contact_id LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.id = ?`,
    dealId,
  );
  if (!deal) throw new HttpError(404, 'Deal not found');
  return deal;
}

function borrowersOf(deal) {
  const people = require('./borrowers').all('deal', deal.id);
  return people;
}

function fromDeal(deal) {
  const loan = db.one('SELECT * FROM loans WHERE deal_id = ?', deal.id);
  const people = borrowersOf(deal);
  const texts = defaultTexts(deal.lender_name, deal.settlement_date, db.getSetting('business_name', ''));
  return clean({
    borrowers: people.map(nameOf).join(' & '),
    lender_id: deal.lender_id,
    lender_name: deal.lender_name,
    lender_phone: deal.lender_phone,
    settlement_date: deal.settlement_date,
    property_address: deal.property_address,
    loans: [{
      account_number: loan?.account_number || deal.application_ref,
      product: deal.product_name || PURPOSE_TYPE[deal.loan_purpose] || null,
      loan_amount: deal.loan_amount,
      interest_rate: deal.interest_rate,
      rate_type: deal.rate_type === 'fixed' ? 'fixed' : 'variable',
      fixed_until: deal.rate_type === 'fixed' ? deal.fixed_expiry_date : null,
      loan_term_years: deal.loan_term_years,
      repayment_type: deal.repayment_type,
      repayment_amount: loan?.repayment_amount ?? null,
      repayment_frequency: loan?.repayment_frequency || 'monthly',
    }],
    direct_debit: {},
    ...texts,
  });
}

function get(dealId) {
  const deal = dealFor(dealId);
  const row = db.one('SELECT s.*, u.name AS sent_by_name FROM settlement_letters s LEFT JOIN users u ON u.id = s.sent_by WHERE s.deal_id = ?', dealId);
  const details = row ? { ...fromDeal(deal), ...JSON.parse(row.details) } : fromDeal(deal);
  return {
    deal_id: deal.id,
    saved: Boolean(row),
    status: row?.status || 'not_started',
    details,
    missing: missing(details),
    ai_read_at: row?.ai_read_at || null,
    ai_files: row?.ai_files ? JSON.parse(row.ai_files) : [],
    updated_at: row?.updated_at || null,
    sent_at: row?.sent_at || null,
    sent_to: row?.sent_to || null,
    sent_by_name: row?.sent_by_name || null,
    to: deal.contact_email || null,
    suggested: ['settlement_booked', 'unconditional_approval', 'settled'].includes(deal.stage),
  };
}

function save(dealId, input, userId, { ai = null } = {}) {
  dealFor(dealId);
  const details = clean(input);
  if (details.lender_id && !db.one('SELECT 1 FROM lenders WHERE id = ?', details.lender_id)) details.lender_id = null;
  // Remember the lender's customer phone number for next time.
  if (details.lender_id && details.lender_phone) {
    db.run("UPDATE lenders SET customer_phone = ? WHERE id = ? AND COALESCE(customer_phone, '') = ''", details.lender_phone, details.lender_id);
  }
  const fields = { details: JSON.stringify(details), updated_at: nowIso() };
  if (ai) Object.assign(fields, { ai_read_at: nowIso(), ai_files: JSON.stringify(ai.files) });
  const existing = db.one('SELECT id FROM settlement_letters WHERE deal_id = ?', dealId);
  if (existing) db.update('settlement_letters', existing.id, fields);
  else db.insert('settlement_letters', { deal_id: dealId, created_by: userId, ...fields });
  return get(dealId);
}

// What the AI found, made safe for clean(): anything that wouldn't pass is
// left blank and flagged for the broker to check.
function fromAI(found = {}) {
  const uncertain = new Set(Array.isArray(found.uncertain) ? found.uncertain : []);
  const okDate = (v, path) => {
    if (v === null || v === undefined || v === '') return null;
    if (DATE.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return String(v);
    uncertain.add(path);
    return null;
  };
  const okNum = (v, path) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[$,\s%]/g, ''));
    if (Number.isFinite(n) && n >= 0) return n;
    uncertain.add(path);
    return null;
  };
  const dd = found.direct_debit || {};
  const bsb = String(dd.bsb || '').replace(/\D/g, '');
  if (dd.bsb && bsb.length !== 6) uncertain.add('direct_debit.bsb');
  const acct = String(dd.account_number || '').replace(/[^\d]/g, '');
  if (dd.account_number && !acct) uncertain.add('direct_debit.account_number');
  const loans = (Array.isArray(found.loans) ? found.loans : []).slice(0, MAX_LOANS).map((l, i) => ({
    ...l,
    loan_amount: okNum(l.loan_amount, `loans[${i}].loan_amount`),
    interest_rate: okNum(l.interest_rate, `loans[${i}].interest_rate`),
    loan_term_years: okNum(l.loan_term_years, `loans[${i}].loan_term_years`),
    repayment_amount: okNum(l.repayment_amount, `loans[${i}].repayment_amount`),
    fixed_until: okDate(l.fixed_until, `loans[${i}].fixed_until`),
    io_until: okDate(l.io_until, `loans[${i}].io_until`),
    first_repayment_date: okDate(l.first_repayment_date, `loans[${i}].first_repayment_date`),
  }));
  const out = clean({
    ...found,
    lender_id: null,
    settlement_date: okDate(found.settlement_date, 'settlement_date'),
    loans,
    direct_debit: { ...dd, bsb: bsb.length === 6 ? bsb : null, account_number: acct || null },
  });
  out.uncertain = [...uncertain];
  // Splits the documents didn't mention keep their own values; rate type etc. default in clean().
  out.loans = out.loans.map((l, i) => ({ ...l, rate_type: loans[i].rate_type ? l.rate_type : null, repayment_type: loans[i].repayment_type ? l.repayment_type : null, repayment_frequency: loans[i].repayment_frequency ? l.repayment_frequency : null }));
  return out;
}

// Merges what the AI read into the current details: filled values win,
// blanks keep what the broker already has.
function mergeExtracted(current, found) {
  const pickVal = (a, b) => (b === null || b === undefined || b === '' ? a : b);
  const loans = (found.loans || []).length ? found.loans.map((l, i) => {
    const before = current.loans[i] || {};
    return Object.fromEntries(Object.keys({ ...before, ...l }).map((k) => [k, pickVal(before[k], l[k])]));
  }) : current.loans;
  const ddFound = found.direct_debit || {};
  return {
    ...current,
    borrowers: pickVal(current.borrowers, found.borrowers),
    lender_name: pickVal(current.lender_name, found.lender_name),
    lender_phone: pickVal(current.lender_phone, found.lender_phone),
    settlement_date: pickVal(current.settlement_date, found.settlement_date),
    property_address: pickVal(current.property_address, found.property_address),
    loans,
    direct_debit: Object.fromEntries(['bank', 'account_name', 'bsb', 'account_number'].map((k) => [k, pickVal(current.direct_debit[k], ddFound[k])])
      .concat([['show_full', current.direct_debit.show_full]])),
    uncertain: found.uncertain || [],
  };
}

// ---- The letter ----------------------------------------------------------------------------------

const maskAccount = (n, full) => {
  if (!n) return '–';
  const digits = String(n).replace(/\D/g, '');
  return full || digits.length <= 4 ? n : `•••• ${digits.slice(-4)}`;
};
const repaymentText = (l) => (l.repayment_amount ? `${aud(l.repayment_amount)} per ${FREQ[l.repayment_frequency] || 'month'}` : '–');
const rateText = (l) => {
  if (l.interest_rate === null || l.interest_rate === undefined) return '–';
  return `${l.interest_rate}% ${l.rate_type === 'fixed' ? `fixed${l.fixed_until ? ` until ${d(l.fixed_until)}` : ''}` : 'variable'}`;
};
const typeText = (l) => (l.repayment_type === 'io' ? `Interest only${l.io_until ? ` until ${d(l.io_until)}` : ''}` : 'Principal & interest');

function model(dealId, details, { userId = null } = {}) {
  const deal = dealFor(dealId);
  const x = details;
  const broker = db.one('SELECT name, email, phone FROM users WHERE id = ?', deal.owner_id || userId) || {};
  const business = {
    name: db.getSetting('business_name', ''), phone: db.getSetting('business_phone', ''), email: db.getSetting('business_email', ''),
    website: db.getSetting('business_website', ''), acl: db.getSetting('acl_number', ''),
  };
  const lenderCell = deal.lender_logo_id && x.lender_id === deal.lender_id ? { text: x.lender_name || '–', logo: deal.lender_logo_id } : x.lender_name || '–';
  const blocks = [];
  if (x.intro) blocks.push({ type: 'text', text: x.intro });
  blocks.push({ type: 'tiles', items: [
    ['Total loan amount', aud(totalLoan(x))],
    ['Lender', x.lender_name || '–'],
    ['Settlement date', d(x.settlement_date)],
    ['First repayment', d(firstRepayment(x))],
  ] });

  blocks.push({ type: 'heading', text: 'Your loan' }, {
    type: 'table',
    widths: [1.5, 1, 0.9, 1.6],
    columns: ['Borrowers', 'Lender', 'Settled', 'Security property'],
    align: ['left', 'left', 'left', 'left'],
    rows: [[x.borrowers || '–', lenderCell, d(x.settlement_date), x.property_address || '–']],
  });
  if (x.loans.length) {
    blocks.push({ type: 'subheading', text: x.loans.length > 1 ? `Your loan is split into ${x.loans.length} accounts` : 'Loan account' }, {
      type: 'table',
      widths: [1.2, 0.9, 1.2, 1.1, 1.1, 1],
      columns: ['Account', 'Loan amount', 'Interest rate', 'Repayment type', 'Repayments', 'First repayment'],
      align: ['left', 'right', 'left', 'left', 'left', 'left'],
      rows: x.loans.map((l) => [
        [l.product, l.account_number ? `Acct ${l.account_number}` : null, l.offset_account ? `Offset ${l.offset_account}` : null, l.loan_term_years ? `${l.loan_term_years}-year term` : null].filter(Boolean).join('\n') || '–',
        aud(l.loan_amount), rateText(l), typeText(l), repaymentText(l), d(l.first_repayment_date),
      ]),
      total: x.loans.length > 1 ? ['Total', aud(totalLoan(x)), '', '', '', ''] : undefined,
    });
  }

  const dd = x.direct_debit;
  blocks.push({ type: 'heading', text: 'Repayments & direct debit' });
  const first = firstRepayment(x);
  const repay = x.loans.filter((l) => l.repayment_amount);
  const lines = [];
  if (repay.length === 1) lines.push(`Your repayments are ${repaymentText(repay[0])}${first ? `, starting on ${d(first)}` : ''}.`);
  else if (repay.length > 1) lines.push(`Your repayments are ${repay.map(repaymentText).join(' + ')}${first ? `, starting on ${d(first)}` : ''}.`);
  if (dd.bsb || dd.account_number) lines.push('They\'ll be direct debited from:');
  blocks.push({ type: 'text', text: lines.join('\n') || 'Your lender will confirm your repayment details.' });
  if (dd.bsb || dd.account_number) {
    blocks.push({
      type: 'table', widths: [1, 1.4, 0.7, 1], columns: ['Bank', 'Account name', 'BSB', 'Account number'], align: ['left', 'left', 'left', 'left'],
      rows: [[dd.bank || '–', dd.account_name || '–', dd.bsb || '–', maskAccount(dd.account_number, dd.show_full)]],
    });
  }
  blocks.push({ type: 'text', text: `• Please make sure the funds are in this account the day before each repayment is due.${x.lender_phone ? `\n• Questions about your account? Call ${x.lender_name || 'your lender'} on ${x.lender_phone}.` : ''}` });

  if (x.next_steps) blocks.push({ type: 'heading', text: 'What happens next' }, { type: 'text', text: x.next_steps });
  blocks.push({
    type: 'note',
    text: `This letter summarises your loan as at settlement. Your loan contract and the lender's documents are the official record: if anything here doesn't match them, please let us know.${business.acl ? ` ${business.name} – ${business.acl}.` : ''}`,
  });
  return {
    title: 'Settlement confirmation',
    prepared_for: x.borrowers || nameOf(deal),
    date: formatDate(today()),
    broker,
    business,
    blocks,
  };
}

const fileName = (x) => `Settlement letter – ${(x.borrowers || 'client').replace(/[\\/:*?"<>|]/g, '')}.pdf`;

// ---- Email -------------------------------------------------------------------------------------------

function emailDraft(dealId, details) {
  const deal = dealFor(dealId);
  const x = details;
  const people = borrowersOf(deal);
  const first = firstRepayment(x);
  const repay = x.loans.filter((l) => l.repayment_amount);
  const dd = x.direct_debit;
  const lines = [
    `Hi ${firstNames(people) || 'there'},`,
    '',
    `Congratulations, your new loan${x.lender_name ? ` with ${x.lender_name}` : ''} has settled${x.settlement_date ? ` (${d(x.settlement_date)})` : ''}! 🎉`,
    '',
    '## Your loan at a glance',
    `- Loan amount: ${aud(totalLoan(x))}${x.loans.length > 1 ? ` across ${x.loans.length} accounts` : ''}`,
    ...x.loans.map((l, i) => `- ${x.loans.length > 1 ? `Split ${i + 1}: ` : 'Interest rate: '}${x.loans.length > 1 ? `${aud(l.loan_amount)} at ` : ''}${rateText(l)}`),
    repay.length ? `- Repayments: ${repay.map(repaymentText).join(' + ')}` : null,
    first ? `- First repayment due: ${d(first)}` : null,
    dd.bsb || dd.account_number ? `- Direct debit from: ${[dd.bank, dd.bsb ? `BSB ${dd.bsb}` : null, `account ${maskAccount(dd.account_number, dd.show_full)}`].filter(Boolean).join(', ')}` : null,
    '',
    'Your settlement letter is attached, with all the details. Please keep it with your loan documents, and make sure the funds are in your account the day before each repayment.',
    '',
    'It\'s been a pleasure helping you. If you have any questions, just reply to this email.',
  ].filter((l) => l !== null);
  return {
    to: deal.contact_email || '',
    subject: `Congratulations, your ${x.lender_name ? `${x.lender_name} ` : ''}loan has settled!`,
    body: lines.join('\n'),
  };
}

async function send(dealId, { to, subject, body }, userId, { auto = false } = {}) {
  const mailer = require('./mailer');
  const deal = dealFor(dealId);
  const letter = get(dealId);
  if (!letter.saved) throw new HttpError(400, 'Save the settlement letter first');
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) throw new HttpError(400, 'Enter the client\'s email address');
  if (!subject || !body) throw new HttpError(400, 'The email needs a subject and a message');
  const pdf = await review.renderPdf(model(dealId, letter.details, { userId }));
  const outboxId = mailer.queueEmail({
    to: String(to).trim(), subject, body, contactId: deal.contact_id, dealId, senderUserId: deal.owner_id || userId,
    attachments: [{ filename: fileName(letter.details), mime: 'application/pdf', data: pdf }],
  });
  await mailer.processOutbox();
  const sent = db.one('SELECT id, status, sent_via, error FROM outbox WHERE id = ?', outboxId);
  if (sent.status === 'failed') throw new HttpError(502, `The email couldn't be sent: ${sent.error}`);
  db.run("UPDATE settlement_letters SET status = 'sent', sent_at = ?, sent_to = ?, sent_by = ?, updated_at = ? WHERE deal_id = ?", nowIso(), String(to).trim(), userId, nowIso(), dealId);
  for (const person of borrowersOf(deal)) {
    db.insert('activities', { contact_id: person.id, deal_id: dealId, user_id: userId, type: 'system', body: `Settlement letter ${auto ? 'sent automatically' : 'emailed'} to ${String(to).trim()}` });
  }
  db.run("UPDATE tasks SET status = 'done' WHERE deal_id = ? AND status = 'open' AND title LIKE 'Send settlement letter%'", dealId);
  return { ...sent, letter: get(dealId) };
}

// When a deal settles: start the letter, and either send it (if that's switched
// on and it's complete) or ask the broker to finish and send it.
async function onSettled(dealId) {
  const deal = db.one('SELECT id, contact_id, owner_id, title FROM deals WHERE id = ?', dealId);
  if (!deal) return null;
  let letter = get(dealId);
  if (letter.status === 'sent') return letter;
  if (!letter.saved) letter = save(dealId, letter.details, deal.owner_id);
  else letter = save(dealId, { ...fromDeal(dealFor(dealId)), ...letter.details, settlement_date: letter.details.settlement_date || dealFor(dealId).settlement_date }, deal.owner_id);
  const ownerId = deal.owner_id || db.one("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id")?.id || null;
  if (db.getSetting('settlement_letter_auto_send', '0') === '1' && !letter.missing.length && letter.to) {
    try {
      const draft = emailDraft(dealId, letter.details);
      return (await send(dealId, draft, ownerId, { auto: true })).letter;
    } catch (err) {
      if (ownerId) db.insert('notifications', { user_id: ownerId, message: `The settlement letter for ${deal.title} couldn't be sent automatically: ${err.message}`, link: `#/deals/${dealId}` });
    }
  }
  if (!db.one("SELECT 1 FROM tasks WHERE deal_id = ? AND title LIKE 'Send settlement letter%'", dealId)) {
    db.insert('tasks', {
      title: `Send settlement letter – ${letter.details.borrowers || deal.title}`,
      description: letter.missing.length ? `Still needed: ${letter.missing.join(', ')}. Upload the loan documents on the deal to fill these in automatically.` : 'The letter is ready to check and send.',
      due_date: today(), priority: 'high', contact_id: deal.contact_id, deal_id: dealId, assigned_to: ownerId, created_by: ownerId,
    });
  }
  return letter;
}

module.exports = { get, save, clean, fromAI, missing, mergeExtracted, model, emailDraft, send, onSettled, fileName, maskAccount };
