'use strict';
// Spreadsheet import: reads .xlsx / .csv, guesses which column is which,
// cleans up values (Australian dates, money, phone numbers, lender names),
// and creates contacts plus their existing loans. Imports never fire
// event automations, and can be undone.
const db = require('../db');
const csv = require('../csv');
const { normaliseMobile } = require('./sms');
const { nowIso, HttpError } = require('../util');

const MAX_ROWS = 20000;

// ---- Field definitions ---------------------------------------------------------

const F = (key, label, group, synonyms, type = 'text') => ({ key, label, group, synonyms, type });
const FIELDS = [
  F('full_name', 'Full name (split into first & last)', 'contact', ['name', 'full name', 'client name', 'client', 'borrower', 'borrower name', 'customer', 'customer name', 'contact name', 'contact']),
  F('first_name', 'First name', 'contact', ['first name', 'firstname', 'given name', 'given names', 'first', 'fname', 'preferred name']),
  F('last_name', 'Last name', 'contact', ['last name', 'lastname', 'surname', 'family name', 'last', 'lname']),
  F('email', 'Email', 'contact', ['email', 'email address', 'e mail', 'primary email', 'email 1', 'personal email'], 'email'),
  F('mobile', 'Mobile', 'contact', ['mobile', 'mobile phone', 'mobile number', 'mobile no', 'mob', 'cell', 'cell phone', 'phone mobile'], 'phone'),
  F('phone', 'Other phone', 'contact', ['phone', 'home phone', 'work phone', 'telephone', 'landline', 'phone number', 'business phone'], 'phone'),
  F('dob', 'Date of birth', 'contact', ['dob', 'date of birth', 'birthday', 'birth date', 'birthdate', 'd o b'], 'date'),
  F('address', 'Street address', 'contact', ['address', 'street', 'street address', 'address line 1', 'address 1', 'residential address', 'home address', 'postal address'], 'text'),
  F('suburb', 'Suburb', 'contact', ['suburb', 'city', 'town', 'locality']),
  F('state', 'State', 'contact', ['state', 'st', 'region'], 'state'),
  F('postcode', 'Postcode', 'contact', ['postcode', 'post code', 'postal code', 'zip', 'pcode'], 'postcode'),
  F('status', 'Status', 'contact', ['status', 'client status', 'contact status', 'contact type', 'client type', 'stage'], 'status'),
  F('lead_source', 'Lead source', 'contact', ['source', 'lead source', 'referral source', 'how did you hear', 'referred by', 'referrer', 'channel']),
  F('employment_type', 'Employment type', 'contact', ['employment', 'employment type', 'employment status', 'occupation type'], 'employment'),
  F('employer', 'Employer / business', 'contact', ['employer', 'company', 'business', 'business name', 'occupation']),
  F('annual_income', 'Annual income', 'contact', ['income', 'annual income', 'salary', 'gross income', 'base salary'], 'money'),
  F('marital_status', 'Marital status', 'contact', ['marital status', 'relationship status', 'marital']),
  F('dependants', 'Dependants', 'contact', ['dependants', 'dependents', 'children', 'no of dependants', 'number of dependants'], 'int'),
  F('tags', 'Tags', 'contact', ['tags', 'tag', 'labels', 'category', 'group', 'segment']),
  F('next_review_date', 'Next review date', 'contact', ['review date', 'next review', 'next review date', 'annual review'], 'date'),
  F('marketing_opt_in', 'Marketing OK (yes/no)', 'contact', ['marketing', 'marketing opt in', 'opt in', 'subscribed', 'newsletter', 'email opt in'], 'bool'),
  F('background', 'Notes', 'contact', ['notes', 'note', 'comments', 'comment', 'background', 'remarks', 'description']),

  F('lender', 'Lender', 'loan', ['lender', 'bank', 'financier', 'lender name', 'funder', 'loan provider'], 'lender'),
  F('loan_amount', 'Loan amount', 'loan', ['loan amount', 'loan', 'amount', 'loan size', 'loan limit', 'limit', 'balance', 'loan balance', 'facility amount', 'amount borrowed'], 'money'),
  F('property_value', 'Property value', 'loan', ['property value', 'valuation', 'security value', 'purchase price', 'value', 'estimated value'], 'money'),
  F('property_address', 'Property / security address', 'loan', ['property address', 'security address', 'security', 'property', 'security property'], 'text'),
  F('interest_rate', 'Interest rate (%)', 'loan', ['rate', 'interest rate', 'current rate', 'interest', 'rate %'], 'percent'),
  F('rate_type', 'Rate type (fixed/variable/split)', 'loan', ['rate type', 'fixed variable', 'fixed or variable', 'interest type', 'fixed var'], 'rate_type'),
  F('fixed_expiry_date', 'Fixed rate expiry', 'loan', ['fixed expiry', 'fixed rate expiry', 'fixed expiry date', 'fixed term expiry', 'fixed until', 'fixed end date', 'fixed rate end', 'fixed term end', 'expiry date', 'expiry'], 'date'),
  F('settlement_date', 'Settlement date', 'loan', ['settlement date', 'settled', 'settlement', 'date settled', 'settled date', 'settled on', 'funded date'], 'date'),
  F('loan_purpose', 'Loan purpose', 'loan', ['purpose', 'loan purpose', 'loan type'], 'purpose'),
  F('loan_term_years', 'Loan term (years)', 'loan', ['term', 'loan term', 'term years', 'loan term years'], 'int'),
  F('repayment_type', 'Repayment type (P&I / IO)', 'loan', ['repayment type', 'repayments', 'p i io', 'repayment'], 'repayment'),
  F('product_name', 'Product', 'loan', ['product', 'product name', 'loan product']),
  F('application_ref', 'Loan / account number', 'loan', ['loan number', 'account number', 'loan account', 'loan account number', 'application ref', 'reference', 'loan id', 'acc no']),
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const LOAN_KEYS = FIELDS.filter((f) => f.group === 'loan').map((f) => f.key);

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

// Picks the best field for each header: exact synonym matches first, then
// headers that contain a synonym. Each field is used once.
function guessMapping(headers) {
  const mapping = headers.map(() => '');
  const used = new Set();
  const assign = (i, key) => { mapping[i] = key; used.add(key); };
  headers.forEach((h, i) => {
    const n = norm(h);
    const f = FIELDS.find((x) => !used.has(x.key) && (norm(x.label) === n || x.synonyms.includes(n)));
    if (f) assign(i, f.key);
  });
  headers.forEach((h, i) => {
    if (mapping[i]) return;
    const n = norm(h);
    if (!n) return;
    let best = null;
    for (const f of FIELDS) {
      if (used.has(f.key)) continue;
      for (const syn of f.synonyms) {
        if (syn.length >= 4 && (` ${n} `).includes(` ${syn} `) && (!best || syn.length > best.len)) best = { key: f.key, len: syn.length };
      }
    }
    if (best) assign(i, best.key);
  });
  // "Name" alongside separate first/last columns is usually redundant.
  if (mapping.includes('full_name') && mapping.includes('first_name')) mapping[mapping.indexOf('full_name')] = '';
  return mapping;
}

// ---- Value parsing ---------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function fullYear(y) {
  if (y >= 100) return y;
  const cutoff = (new Date().getFullYear() % 100) + 10; // 2-digit years: up to ~10 years ahead are 20xx
  return y <= cutoff ? 2000 + y : 1900 + y;
}

// Dates as Excel gives them (Date / serial number) or as typed: Australian
// day-first formats, ISO, and written months.
function parseDate(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  if (v instanceof Date) return { value: v.toISOString().slice(0, 10) };
  if (typeof v === 'number') {
    if (v > 59 && v < 80000) return { value: new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) };
    return { error: `"${v}" is not a date` };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) {
    const d = validDate(+m[1], +m[2], +m[3]);
    return d ? { value: d } : { error: `"${s}" is not a real date` };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const d = validDate(fullYear(+m[3]), +m[2], +m[1]);
    if (d) return { value: d };
    const us = validDate(fullYear(+m[3]), +m[1], +m[2]);
    return us ? { value: us, warning: `"${s}" read as month/day (${us})` } : { error: `"${s}" is not a real date` };
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,})\.?[\s,-]+(\d{2,4})$/i);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) {
    const d = validDate(fullYear(+m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
    if (d) return { value: d };
  }
  m = s.match(/^([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) {
    const d = validDate(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
    if (d) return { value: d };
  }
  return { error: `"${s}" is not a date we recognise (use DD/MM/YYYY)` };
}

function parseMoney(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  if (typeof v === 'number') return { value: v };
  const s = String(v).trim().toLowerCase().replace(/aud|\$|,|\s/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return { error: `"${v}" is not an amount` };
  return { value: Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) * 100) / 100 };
}

function parsePercent(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[%\s]/g, ''));
  if (!Number.isFinite(n)) return { error: `"${v}" is not a rate` };
  const pct = n > 0 && n < 0.3 ? n * 100 : n; // 0.0589 from a %-formatted Excel cell
  if (pct < 0 || pct > 30) return { error: `${v} doesn't look like an interest rate` };
  return { value: Math.round(pct * 1000) / 1000 };
}

function parsePhone(v) {
  if (v === null || v === undefined || v === '') return { value: null };
  let s = typeof v === 'number' ? String(Math.round(v)) : String(v).trim();
  if (/^4\d{8}$/.test(s) || /^[2378]\d{8}$/.test(s)) s = `0${s}`; // Excel dropped the leading zero
  const digits = s.replace(/[^\d+]/g, '');
  if (/^04\d{8}$/.test(digits)) return { value: `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}` };
  if (/^0[2378]\d{8}$/.test(digits)) return { value: `(${digits.slice(0, 2)}) ${digits.slice(2, 6)} ${digits.slice(6)}` };
  if (/^\+?61 ?4\d{8}$/.test(digits)) return { value: `0${digits.replace(/^\+?61/, '').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3')}` };
  return { value: s, warning: digits.length < 8 ? `"${s}" looks too short for a phone number` : null };
}

const STATES = {
  nsw: 'NSW', 'new south wales': 'NSW', vic: 'VIC', victoria: 'VIC', qld: 'QLD', queensland: 'QLD', wa: 'WA', 'western australia': 'WA',
  sa: 'SA', 'south australia': 'SA', tas: 'TAS', tasmania: 'TAS', act: 'ACT', 'australian capital territory': 'ACT', nt: 'NT', 'northern territory': 'NT',
};

const STATUS_WORDS = [
  [/^(client|customer|settled|active|current|existing|funded|won)/, 'client'],
  [/^(past|former|previous|inactive|discharged|closed|paid out|refinanced away|ex)/, 'past_client'],
  [/^(lead|enquiry|inquiry|new|cold|warm|hot|unqualified)/, 'lead'],
  [/^(prospect|pipeline|in progress|working|qualified|opportunity|application)/, 'prospect'],
  [/^(lost|dead|declined|not proceeding|withdrawn|archived)/, 'lost'],
];

const ENUMS = {
  rate_type: (s) => (/split/.test(s) ? 'split' : /fix/.test(s) ? 'fixed' : /var/.test(s) ? 'variable' : null),
  repayment: (s) => (/interest only|^io$|^i\/?o$/.test(s) ? 'io' : /p\s*&?\s*i|principal|^pi$/.test(s) ? 'pi' : null),
  employment: (s) => (/self/.test(s) ? 'self_employed' : /contract/.test(s) ? 'contractor' : /casual/.test(s) ? 'casual' : /retire/.test(s) ? 'retired'
    : /payg|employ|full|part|salar|wage/.test(s) ? 'payg' : 'other'),
  purpose: (s) => (/first/.test(s) ? 'first_home' : /refi/.test(s) ? 'refinance' : /invest/.test(s) ? 'investment' : /constr|build/.test(s) ? 'construction'
    : /top|equity|cash ?out/.test(s) ? 'top_up' : /commerc|business/.test(s) ? 'commercial' : /purchas|owner|home|buy/.test(s) ? 'purchase' : 'other'),
};

// Lender names as brokers commonly write them.
const LENDER_ALIASES = {
  cba: 'Commonwealth Bank', commbank: 'Commonwealth Bank', commonwealth: 'Commonwealth Bank', 'commonwealth bank of australia': 'Commonwealth Bank',
  nab: 'NAB', 'national australia bank': 'NAB', 'national bank': 'NAB', westpac: 'Westpac', wbc: 'Westpac', anz: 'ANZ',
  macquarie: 'Macquarie Bank', mqg: 'Macquarie Bank', ing: 'ING', 'ing direct': 'ING', 'st george': 'St.George', stg: 'St.George', 'st.george bank': 'St.George',
  boq: 'Bank of Queensland', 'bank of qld': 'Bank of Queensland', bankwest: 'Bankwest', suncorp: 'Suncorp', 'suncorp bank': 'Suncorp',
  pepper: 'Pepper Money', liberty: 'Liberty', 'liberty financial': 'Liberty',
};

function lenderLookup() {
  const lenders = db.all('SELECT id, name FROM lenders');
  const byName = new Map(lenders.map((l) => [norm(l.name), l]));
  return (raw) => {
    const n = norm(raw);
    if (!n) return null;
    if (byName.has(n)) return byName.get(n);
    const alias = LENDER_ALIASES[n] || LENDER_ALIASES[n.replace(/ (bank|limited|ltd|home loans?)$/, '')];
    if (alias && byName.has(norm(alias))) return byName.get(norm(alias));
    return lenders.find((l) => n.includes(norm(l.name)) || norm(l.name).includes(n)) || null;
  };
}

function parseValue(field, raw, ctx) {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === null || s === undefined || s === '') return { value: null };
  switch (field.type) {
    case 'date': return parseDate(s);
    case 'money': return parseMoney(s);
    case 'percent': return parsePercent(s);
    case 'phone': return parsePhone(s);
    case 'int': {
      const n = Number(String(s).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? { value: Math.round(n) } : { error: `"${s}" is not a number` };
    }
    case 'email': {
      const e = String(s).toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? { value: e } : { error: `"${s}" is not a valid email`, value: null };
    }
    case 'state': {
      const v = STATES[norm(s)];
      return v ? { value: v } : { value: String(s).toUpperCase().slice(0, 3), warning: `Unknown state "${s}"` };
    }
    case 'postcode': return { value: String(s).replace(/\.0$/, '').padStart(4, '0') };
    case 'bool': return { value: /^(y|yes|true|1|opt.?in|subscribed|ok)$/i.test(String(s).trim()) ? 1 : 0 };
    case 'status': {
      const hit = STATUS_WORDS.find(([re]) => re.test(norm(s)));
      return hit ? { value: hit[1] } : { value: null, warning: `Status "${s}" not recognised – using the default` };
    }
    case 'lender': {
      const l = ctx.findLender(s);
      return l ? { value: l.id, display: l.name } : { value: null, newLender: String(s).trim() };
    }
    default: {
      if (ENUMS[field.type]) return { value: ENUMS[field.type](norm(s)) };
      return { value: s instanceof Date ? s.toISOString().slice(0, 10) : String(s) };
    }
  }
}

// ---- Reading files ----------------------------------------------------------------

function cellOut(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v === undefined ? null : v;
}

// First row with at least two filled cells is taken as the header row.
function splitHeader(rows) {
  const idx = rows.findIndex((r) => r.filter((c) => c !== null && c !== undefined && String(c).trim() !== '').length >= 2);
  if (idx === -1) return { headers: [], rows: [], headerRow: 0 };
  const headers = rows[idx].map((h, i) => (h === null || h === undefined || String(h).trim() === '' ? `Column ${i + 1}` : String(h).trim()));
  const body = rows.slice(idx + 1)
    .map((r) => headers.map((_, i) => cellOut(r[i])))
    .filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));
  return { headers, rows: body, headerRow: idx + 1 };
}

async function readWorkbook(buffer, filename = '') {
  if (buffer.length < 4) throw new HttpError(400, 'That file is empty');
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOldExcel = buffer[0] === 0xd0 && buffer[1] === 0xcf;
  if (isOldExcel) throw new HttpError(400, 'This is an old-style .xls file. In Excel, choose File → Save As → Excel Workbook (.xlsx), then upload that.');
  let sheets;
  if (isZip) {
    const { default: readXlsxFile } = require('read-excel-file/node');
    try {
      sheets = (await readXlsxFile(buffer)).map((s) => ({ name: s.sheet, raw: s.data }));
    } catch {
      throw new HttpError(400, 'That spreadsheet could not be read. Try saving it again as .xlsx or CSV.');
    }
  } else {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    if (/\u0000/.test(text.slice(0, 1000))) throw new HttpError(400, 'Please upload an Excel (.xlsx) or CSV file');
    const firstLine = text.split(/\r?\n/)[0];
    const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
    sheets = [{ name: filename.replace(/\.[^.]+$/, '') || 'Sheet1', raw: csv.parseRows(text, delimiter) }];
  }
  return sheets.map((s) => {
    const { headers, rows, headerRow } = splitHeader(s.raw);
    if (rows.length > MAX_ROWS) throw new HttpError(400, `"${s.name}" has ${rows.length} rows – please split it into files of up to ${MAX_ROWS}`);
    return { name: s.name, headers, rows, header_row: headerRow, mapping: guessMapping(headers) };
  });
}

// ---- Processing rows ----------------------------------------------------------------

function splitName(full) {
  const s = String(full || '').trim().replace(/\s+/g, ' ');
  if (!s) return {};
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return { first_name: first || last, last_name: first ? last : null };
  }
  const parts = s.split(' ');
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') || null };
}

// Turns raw rows into contact/loan records with errors, warnings and
// duplicate detection. Used for both preview and the real import.
function processRows({ headers, rows, mapping, options = {} }) {
  if (!Array.isArray(rows) || !Array.isArray(mapping) || mapping.length !== headers.length) throw new HttpError(400, 'Column mapping is missing');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `Too many rows (max ${MAX_ROWS})`);
  for (const key of mapping) if (key && !BY_KEY[key]) throw new HttpError(400, `Unknown field "${key}"`);
  const mapped = mapping.filter(Boolean);
  if (!mapped.includes('first_name') && !mapped.includes('full_name')) throw new HttpError(400, 'Match a column to "First name" or "Full name" so each client has a name');

  const ctx = { findLender: lenderLookup() };
  const existingByEmail = new Map(db.all("SELECT id, email FROM contacts WHERE email IS NOT NULL AND email != ''").map((c) => [c.email.toLowerCase(), c.id]));
  const existingByMobile = new Map();
  for (const c of db.all("SELECT id, mobile FROM contacts WHERE mobile IS NOT NULL AND mobile != ''")) {
    const m = normaliseMobile(c.mobile);
    if (m) existingByMobile.set(m, c.id);
  }
  const seenEmail = new Map();
  const seenMobile = new Map();
  const newLenders = new Map();
  const defaultStatus = options.default_status || 'client';

  const records = rows.map((row, i) => {
    const rec = { row: i + 1, contact: {}, loan: {}, errors: [], warnings: [], action: 'create', duplicate_of: null };
    mapping.forEach((key, col) => {
      if (!key) return;
      const field = BY_KEY[key];
      const r = parseValue(field, row[col], ctx);
      const label = `${field.label}`;
      if (r.error) rec.warnings.push(`${label}: ${r.error}`);
      if (r.warning) rec.warnings.push(`${label}: ${r.warning}`);
      if (key === 'full_name') Object.assign(rec.contact, Object.fromEntries(Object.entries(splitName(r.value)).filter(([k]) => !rec.contact[k])));
      else if (key === 'lender') {
        if (r.newLender) {
          rec.loan.new_lender = r.newLender;
          newLenders.set(norm(r.newLender), r.newLender);
        } else if (r.value) {
          rec.loan.lender_id = r.value;
          rec.loan.lender_name = r.display;
        }
      } else if (field.group === 'loan') {
        if (r.value !== null && r.value !== undefined) rec.loan[key] = r.value;
      } else if (r.value !== null && r.value !== undefined && r.value !== '') rec.contact[key] = r.value;
    });

    if (!rec.contact.first_name) rec.errors.push('No name');
    rec.contact.status = rec.contact.status || defaultStatus;
    const hasLoan = LOAN_KEYS.some((k) => rec.loan[k] !== undefined) || rec.loan.new_lender || rec.loan.lender_id;
    if (!hasLoan) rec.loan = null;
    else if (rec.loan.fixed_expiry_date && !rec.loan.rate_type) rec.loan.rate_type = 'fixed';

    // Duplicates: against the CRM, then earlier rows in this file.
    const email = rec.contact.email;
    const mobile = normaliseMobile(rec.contact.mobile);
    const existing = (email && existingByEmail.get(email)) || (mobile && existingByMobile.get(mobile)) || null;
    const earlier = (email && seenEmail.get(email)) || (mobile && seenMobile.get(mobile)) || null;
    if (rec.errors.length) rec.action = 'skip';
    else if (existing) {
      rec.duplicate_of = existing;
      rec.action = options.duplicates === 'update' ? 'update' : 'skip';
      rec.warnings.push(`Already in the CRM${options.duplicates === 'update' ? ' – blank details will be filled in' : ' – skipped'}`);
    } else if (earlier) {
      rec.action = 'skip';
      rec.warnings.push(`Same person as row ${earlier} – skipped`);
    }
    if (rec.action === 'update' && rec.loan && !rec.loan.new_lender && db.one(
      'SELECT 1 AS x FROM deals WHERE contact_id = ? AND COALESCE(lender_id,0) = COALESCE(?,0) AND COALESCE(loan_amount,0) = COALESCE(?,0)',
      existing, rec.loan.lender_id ?? null, rec.loan.loan_amount ?? null,
    )) {
      rec.loan = null;
      rec.warnings.push('This loan is already recorded – not added again');
    }
    if (rec.action === 'create') {
      if (email) seenEmail.set(email, rec.row);
      if (mobile) seenMobile.set(mobile, rec.row);
    }
    return rec;
  });

  const count = (fn) => records.filter(fn).length;
  return {
    records,
    summary: {
      rows: records.length,
      create: count((r) => r.action === 'create'),
      update: count((r) => r.action === 'update'),
      skip: count((r) => r.action === 'skip'),
      with_errors: count((r) => r.errors.length > 0),
      with_warnings: count((r) => r.warnings.length > 0 && !r.errors.length),
      loans: count((r) => r.loan && r.action !== 'skip'),
      new_lenders: [...newLenders.values()],
    },
  };
}

const CONTACT_COLS = ['first_name', 'last_name', 'email', 'mobile', 'phone', 'dob', 'address', 'suburb', 'state', 'postcode', 'status', 'lead_source',
  'employment_type', 'employer', 'annual_income', 'marital_status', 'dependants', 'tags', 'next_review_date', 'marketing_opt_in', 'background'];
const DEAL_COLS = ['loan_amount', 'property_value', 'property_address', 'interest_rate', 'rate_type', 'fixed_expiry_date', 'settlement_date',
  'loan_purpose', 'loan_term_years', 'repayment_type', 'product_name', 'application_ref'];

function commit({ filename, sheet, headers, rows, mapping, options = {} }, userId) {
  const { records, summary } = processRows({ headers, rows, mapping, options });
  const ownerId = Number(options.owner_id) || userId;
  const stage = ['settled', 'lead', 'fact_find', 'pre_approval', 'application_lodged', 'conditional_approval', 'unconditional_approval', 'settlement_booked'].includes(options.loan_stage)
    ? options.loan_stage : 'settled';
  const extraTag = String(options.tag || '').trim();
  const marketingDefault = options.marketing_default === false || options.marketing_default === 0 ? 0 : 1;
  const createdContacts = [];
  const createdDeals = [];
  let updated = 0;

  const result = db.transaction(() => {
    const importId = db.insert('imports', {
      filename: String(filename || 'spreadsheet').slice(0, 200), sheet: sheet ? String(sheet).slice(0, 100) : null, created_by: userId,
      options: JSON.stringify(options),
    });
    const lenderIds = new Map();
    const lenderFor = (name) => {
      const key = norm(name);
      if (!lenderIds.has(key)) {
        const existing = db.one('SELECT id FROM lenders WHERE lower(name) = lower(?)', name);
        lenderIds.set(key, existing ? existing.id : db.insert('lenders', { name }));
      }
      return lenderIds.get(key);
    };

    for (const rec of records) {
      if (rec.action === 'skip') continue;
      let contactId;
      const c = { ...rec.contact };
      if (extraTag) c.tags = [...new Set([...String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean), extraTag])].join(',');
      if (rec.action === 'update') {
        contactId = rec.duplicate_of;
        const current = db.one('SELECT * FROM contacts WHERE id = ?', contactId);
        const patch = {};
        for (const k of CONTACT_COLS) {
          if (c[k] === undefined || c[k] === null || c[k] === '') continue;
          if (k === 'tags') {
            const merged = [...new Set([...String(current.tags || '').split(','), ...String(c.tags).split(',')].map((t) => t.trim()).filter(Boolean))].join(',');
            if (merged !== current.tags) patch.tags = merged;
          } else if (current[k] === null || current[k] === '' || current[k] === undefined) patch[k] = c[k];
        }
        if (Object.keys(patch).length) {
          db.update('contacts', contactId, { ...patch, updated_at: nowIso() });
          updated++;
        }
      } else {
        const row = Object.fromEntries(CONTACT_COLS.filter((k) => c[k] !== undefined && c[k] !== null && c[k] !== '').map((k) => [k, c[k]]));
        contactId = db.insert('contacts', {
          marketing_opt_in: marketingDefault, ...row, owner_id: ownerId, import_id: importId, tags: row.tags || '',
        });
        createdContacts.push(contactId);
        db.insert('activities', { contact_id: contactId, user_id: userId, type: 'system', body: `Imported from ${filename || 'spreadsheet'}` });
      }

      if (rec.loan) {
        const l = rec.loan;
        // Don't add the same loan twice when re-importing.
        const dupLoan = rec.action === 'update' && db.one(
          'SELECT 1 AS x FROM deals WHERE contact_id = ? AND COALESCE(lender_id,0) = COALESCE(?,0) AND COALESCE(loan_amount,0) = COALESCE(?,0)',
          contactId, l.lender_id ?? (l.new_lender ? lenderFor(l.new_lender) : null), l.loan_amount ?? null,
        );
        if (!dupLoan) {
          const lenderId = l.lender_id ?? (l.new_lender ? lenderFor(l.new_lender) : null);
          const lenderName = l.lender_name || l.new_lender || '';
          const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || db.one('SELECT first_name FROM contacts WHERE id = ?', contactId).first_name;
          const deal = Object.fromEntries(DEAL_COLS.filter((k) => l[k] !== undefined).map((k) => [k, l[k]]));
          const dealId = db.insert('deals', {
            ...deal,
            loan_purpose: deal.loan_purpose || 'other',
            title: `${name} – ${lenderName || 'existing loan'}`.trim(),
            contact_id: contactId,
            lender_id: lenderId,
            stage,
            stage_changed_at: deal.settlement_date && stage === 'settled' ? `${deal.settlement_date}T00:00:00.000Z` : nowIso(),
            owner_id: ownerId,
            import_id: importId,
          });
          db.insert('deal_stage_history', { deal_id: dealId, from_stage: null, to_stage: stage, changed_by: userId });
          createdDeals.push(dealId);
        }
      }
    }

    // Don't immediately message imported clients about things that are
    // already due (e.g. a fixed rate expiring next month); future dates still fire.
    let held = 0;
    if (options.hold_due_automations !== false) {
      held = require('./automation').markScheduledDone({ contactIds: createdContacts, dealIds: createdDeals }, 'Imported – already due at import');
    }
    db.update('imports', importId, {
      contacts_created: createdContacts.length, contacts_updated: updated, deals_created: createdDeals.length,
      skipped: summary.skip, held_automations: held,
    });
    return { import_id: importId, contacts_created: createdContacts.length, contacts_updated: updated, deals_created: createdDeals.length, skipped: summary.skip, held_automations: held, new_lenders: summary.new_lenders };
  });
  return result;
}

function undo(importId, user) {
  const imp = db.one('SELECT * FROM imports WHERE id = ?', importId);
  if (!imp) throw new HttpError(404, 'Import not found');
  if (imp.undone_at) throw new HttpError(400, 'This import was already undone');
  if (imp.created_by !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the person who ran this import (or an admin) can undo it');
  return db.transaction(() => {
    const deals = db.run('DELETE FROM deals WHERE import_id = ?', importId).changes;
    const contacts = db.run('DELETE FROM contacts WHERE import_id = ?', importId).changes;
    db.update('imports', importId, { undone_at: nowIso() });
    return { contacts_removed: Number(contacts), deals_removed: Number(deals) };
  });
}

// A starter spreadsheet (CSV) with the recommended columns.
function templateCsv() {
  const headers = ['First Name', 'Surname', 'Email', 'Mobile', 'DOB', 'Address', 'Suburb', 'State', 'Postcode', 'Status', 'Lead Source', 'Tags', 'Notes',
    'Lender', 'Loan Amount', 'Property Value', 'Property Address', 'Interest Rate', 'Rate Type', 'Fixed Expiry', 'Settlement Date', 'Loan Purpose', 'Loan Number'];
  const sample = ['Jane', 'Citizen', 'jane@example.com', '0412 345 678', '14/03/1985', '1 Example St', 'Parramatta', 'NSW', '2150', 'Client', 'Referral', 'investor', 'Prefers email',
    'CBA', '$520,000', '$780,000', '1 Example St Parramatta NSW 2150', '5.89%', 'Fixed', '30/06/2027', '15/07/2024', 'Purchase', '123456789'];
  return csv.stringify([Object.fromEntries(headers.map((h, i) => [h, sample[i]]))], headers);
}

module.exports = {
  FIELDS, guessMapping, parseDate, parseMoney, parsePercent, parsePhone, readWorkbook, processRows, commit, undo, templateCsv, splitName,
};
