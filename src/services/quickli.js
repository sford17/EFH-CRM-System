'use strict';
// Quickli (servicing calculator) integration, using the Quickli External API v3.
//
// Every request is signed: five X-Auth-* headers carry the integration partner
// ID, the broker's access token, the ID of an RSA key registered with Quickli,
// a timestamp, and an RSA-SHA256 signature of
//   METHOD \n PATH \n TIMESTAMP \n SHA256_HEX(BODY)
// The CRM generates the key pair; the public key is given to Quickli once.
//
// A deal's borrowers, income, properties, existing loans, debts and the new
// loan are sent as a Quickli scenario, which stays linked to the deal.
const crypto = require('node:crypto');
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');
const household = require('./household');
const tracker = require('./tracker');

const base = () => (process.env.QUICKLI_API_URL || 'https://external-api.quickli.com.au').replace(/\/+$/, '');

// ---- Settings ----------------------------------------------------------------------------

function privateKey() {
  try {
    return decrypt(db.getSetting('quickli_private_key', '')) || null;
  } catch {
    return null;
  }
}

function config() {
  const pem = privateKey();
  return {
    partnerId: db.getSetting('quickli_partner_id', '') || '',
    keyId: db.getSetting('quickli_key_id', '') || '',
    hasKey: Boolean(pem),
    publicKey: pem ? crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }) : null,
    scenarioUrl: db.getSetting('quickli_scenario_url', '') || '',
  };
}
const configured = () => {
  const c = config();
  return Boolean(c.partnerId && c.keyId && c.hasKey);
};

function saveConfig({ partner_id, key_id, scenario_url }) {
  const clean = (v, label) => {
    const s = String(v || '').trim();
    if (s && !/^[\w.:@-]{1,200}$/.test(s)) throw new HttpError(400, `The ${label} doesn't look right. Paste it exactly as Quickli gave it to you.`);
    return s;
  };
  if (partner_id !== undefined) db.setSetting('quickli_partner_id', clean(partner_id, 'partner ID'));
  if (key_id !== undefined) db.setSetting('quickli_key_id', clean(key_id, 'key ID'));
  if (scenario_url !== undefined) {
    const u = String(scenario_url || '').trim();
    if (u && (!/^https:\/\/\S+$/.test(u) || !u.includes('{id}'))) throw new HttpError(400, 'The scenario link should start with https:// and include {id} where the scenario ID goes');
    db.setSetting('quickli_scenario_url', u);
  }
  return config();
}

// A new RSA key pair; the private key never leaves the CRM (stored encrypted).
function generateKey() {
  const { privateKey: pem } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  db.setSetting('quickli_private_key', encrypt(pem));
  db.setSetting('quickli_key_id', ''); // a new key needs registering with Quickli again
  return config();
}

// An existing PKCS#8 private key (e.g. one already registered with Quickli).
function importKey(pem) {
  const text = String(pem || '').trim();
  if (/BEGIN RSA PRIVATE KEY/.test(text)) throw new HttpError(400, 'That key is in PKCS#1 format. Quickli needs PKCS#8 ("BEGIN PRIVATE KEY").');
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(text)) throw new HttpError(400, 'Paste the whole private key, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----');
  try {
    const k = crypto.createPrivateKey(text);
    if (k.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new HttpError(400, 'That isn\'t a valid RSA private key');
  }
  db.setSetting('quickli_private_key', encrypt(text));
  return config();
}

// ---- Each broker's access token ------------------------------------------------------------

function tokenFor(userId) {
  const row = db.one('SELECT * FROM quickli_tokens WHERE user_id = ?', userId);
  if (!row) return null;
  try {
    return { ...row, token: decrypt(row.token) };
  } catch {
    return null;
  }
}

function tokenStatus(userId) {
  const row = db.one('SELECT verified_at, whoami, last_error, updated_at FROM quickli_tokens WHERE user_id = ?', userId);
  if (!row) return null;
  return { verified_at: row.verified_at, whoami: row.whoami ? JSON.parse(row.whoami) : null, last_error: row.last_error, updated_at: row.updated_at };
}

// ---- Signed requests -------------------------------------------------------------------------

// The body that's hashed must match how Quickli re-serialises it: objects as
// minified JSON; empty bodies (and {} / []) as "".
function signingBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'object' && Object.keys(body).length === 0) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function sign({ method, path, body, token, now = new Date() }) {
  const c = config();
  const pem = privateKey();
  const timestamp = now.toISOString();
  const bodyHash = crypto.createHash('sha256').update(signingBody(body), 'utf8').digest('hex');
  const canonical = [method.toUpperCase(), path.split('?')[0], timestamp, bodyHash].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(canonical, 'utf8').sign(pem, 'base64');
  return {
    'x-auth-integration-partner-id': c.partnerId,
    'x-auth-broker-access-token': token,
    'x-auth-key-id': c.keyId,
    'x-auth-timestamp': timestamp,
    'x-auth-signature': signature,
  };
}

async function request(userId, method, path, body) {
  if (!configured()) throw new HttpError(400, 'Quickli isn\'t set up yet. An admin needs to finish the Quickli setup in Settings.');
  const t = tokenFor(userId);
  if (!t) throw new HttpError(400, 'Add your Quickli access token in Settings → Quickli first.');
  const json = body && Object.keys(body).length ? JSON.stringify(body) : '';
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { ...sign({ method, path, body: json, token: t.token }), ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json || undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw new HttpError(502, `Couldn't reach Quickli (${err.cause?.code || err.name}). Check the internet connection and try again.`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const msg = data.message || data.error?.message || (typeof data.error === 'string' ? data.error : null) || `error ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      db.run('UPDATE quickli_tokens SET last_error = ? WHERE user_id = ?', `Quickli didn't accept the connection: ${msg}`, userId);
      // Never a 401 from us: that would sign the broker out of the CRM.
      throw new HttpError(400, `Quickli didn't accept the connection (${msg}). Check your access token in Settings → Quickli, and that the CRM's key is registered with Quickli.`);
    }
    if (res.status === 404) throw new HttpError(404, 'Quickli couldn\'t find that scenario. Check the scenario ID.');
    if (res.status === 400 || res.status === 422) throw new HttpError(400, `Quickli couldn't use the details: ${msg}`);
    throw new HttpError(502, `Quickli had a problem (${res.status}): ${msg}`);
  }
  return data;
}

async function verifyToken(userId, token) {
  const t = String(token || '').trim();
  if (t.length < 10 || /\s/.test(t)) throw new HttpError(400, 'Paste the whole access token from Quickli (Settings → Integrations)');
  const existing = db.one('SELECT user_id FROM quickli_tokens WHERE user_id = ?', userId);
  const row = { token: encrypt(t), verified_at: null, whoami: null, last_error: null, updated_at: nowIso() };
  if (existing) db.run('UPDATE quickli_tokens SET token = ?, verified_at = NULL, whoami = NULL, last_error = NULL, updated_at = ? WHERE user_id = ?', row.token, row.updated_at, userId);
  else db.insert('quickli_tokens', { user_id: userId, ...row });
  return test(userId);
}

async function test(userId) {
  try {
    const me = await request(userId, 'GET', '/api/v3/whoami');
    db.run('UPDATE quickli_tokens SET verified_at = ?, whoami = ?, last_error = NULL WHERE user_id = ?', nowIso(), JSON.stringify(me).slice(0, 4000), userId);
    return { ok: true, whoami: me };
  } catch (err) {
    db.run('UPDATE quickli_tokens SET last_error = ? WHERE user_id = ?', err.message, userId);
    return { ok: false, error: err.message };
  }
}

const disconnect = (userId) => db.run('DELETE FROM quickli_tokens WHERE user_id = ?', userId);

// ---- Building a scenario from a deal --------------------------------------------------------------

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const postcodeOf = (c) => (c && /^\d{4}$/.test(String(c.postcode || '').trim()) ? Number(c.postcode) : null);
const normAddr = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MONTHLY = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1 };
const monthly = (n) => (n.repayment_amount ? Math.round(n.repayment_amount * (MONTHLY[n.repayment_frequency] || 1) * 100) / 100 : null);
const yearsUntil = (date) => (date ? Math.max(0, (Date.parse(`${date}T00:00:00Z`) - Date.now()) / (365.25 * 86400000)) : 0);
function productType(rateType, fixedYears) {
  if (rateType !== 'fixed') return 'variable_package';
  const y = Math.ceil(fixedYears || 0);
  if (!y) return 'fixed_rate_2_year';
  if (y > 7) return 'fixed_rate_10_year';
  if (y > 5) return 'fixed_rate_7_year';
  return `fixed_rate_${Math.min(5, y)}_year`;
}
const PROPERTY_TYPE = { house: 'house', townhouse: 'house', unit: 'apartment', land: 'land', rural: 'other', commercial: 'other', other: 'other' };
const LIABILITY_TYPE = { credit_card: 'credit_card', car: 'car', personal: 'personal' };
const HOME_LOANS = ['home_loan', 'investment_loan', 'line_of_credit', 'construction', 'bridging', 'commercial'];
const PURCHASES = ['purchase', 'first_home', 'investment', 'construction', 'commercial'];

// Returns { scenario, summary, warnings }: what will be sent, a plain-English
// summary of it, and things the broker should add in Quickli.
function buildScenario(dealId) {
  const deal = db.one('SELECT d.*, l.name AS lender_name FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.id = ?', dealId);
  if (!deal) throw new HttpError(404, 'Deal not found');
  // Quickli applicants are people: a company or trust borrower is represented by its directors/trustees.
  const onDeal = require('./borrowers').all('deal', deal.id);
  const applicants = require('./borrowers').addresseesFor(onDeal)
    .map((p) => db.one('SELECT * FROM contacts WHERE id = ?', p.id)).filter((c) => c && c.entity_type === 'person');
  if (!applicants.length) throw new HttpError(400, 'Link the company\'s directors or the trust\'s trustees (Related contacts) so Quickli has applicants');
  const warnings = onDeal.filter((b) => b.entity_type !== 'person')
    .map((b) => `${b.full_name} is a ${b.entity_type}: its ${b.entity_type === 'trust' ? 'trustees' : 'directors'} are sent as the applicants. Add the ${b.entity_type}'s own income in Quickli.`);
  const ids = household.householdIds(deal.contact_id);
  for (const a of applicants) if (!ids.includes(a.id)) ids.push(a.id);
  const position = tracker.summary(deal.contact_id);
  const appIndex = new Map(applicants.map((a, i) => [a.id, i]));
  const ownership = (ownerId, coOwnerId) => {
    const share = applicants.map(() => 0);
    const owners = [ownerId, coOwnerId].filter((id) => appIndex.has(id));
    if (!owners.length) return applicants.map((_, i) => (i === 0 ? 100 : 0));
    for (const id of owners) share[appIndex.get(id)] = Math.round(100 / owners.length);
    return share;
  };

  // Household: the borrowers (a couple shares one household).
  // A partner sharing finances counts as the second adult even if not borrowing.
  const partner = applicants[1] || household.household(deal.contact_id).find((m) => m.id !== deal.contact_id) || null;
  const rel = partner
    ? db.one('SELECT relationship FROM contact_relationships WHERE (contact_id = ? AND related_id = ?) OR (contact_id = ? AND related_id = ?)', applicants[0].id, partner.id, partner.id, applicants[0].id)
    : null;
  const adults = partner ? 2 : 1;
  const status = partner ? (rel?.relationship === 'spouse' ? 'married' : 'defacto')
    : (['married', 'de_facto', 'defacto'].includes(String(applicants[0]?.marital_status || '').toLowerCase()) ? 'married' : 'single');
  const dependants = Math.max(0, ...applicants.map((a) => Number(a.dependants) || 0));
  const postcode = postcodeOf(applicants.find(postcodeOf));
  if (!postcode) warnings.push('No postcode on the borrower\'s address (used for living expense benchmarks).');
  const households = [{ id: 'crm-household-1', status, num_adults: adults, num_dependants: dependants, shared_with_households: [], ...(postcode ? { postcode } : {}) }];
  // Living expenses from the client's online fact find (monthly, Quickli's categories).
  const parsed = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const declared = [...applicants, ...(partner && !applicants.includes(partner) ? [db.one('SELECT living_expenses FROM contacts WHERE id = ?', partner.id) || {}] : [])]
    .map((a) => parsed(a.living_expenses)).find((e) => e && Object.keys(e).length);
  const living_expenses = [declared
    ? { id: 'crm-household-1', use_detailed_basic_expense: true, simple_basic_expense: 0, ...Object.fromEntries(Object.entries(declared).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100])) }
    : { id: 'crm-household-1', simple_basic_expense: 0, use_detailed_basic_expense: false }];
  if (!declared) warnings.push('Living expenses aren\'t recorded in the CRM: send the online fact find, or enter them in Quickli.');

  // Income, one entry per borrower.
  const hecs = new Map();
  const self_employed_income = [];
  const income = applicants.map((a) => {
    const row = { id: `crm-income-${a.id}`, name: [a.first_name, a.last_name].filter(Boolean).join(' '), which_household: 0 };
    const type = String(a.employment_type || '').toLowerCase();
    const detail = parsed(a.income_details);
    const business = parsed(a.self_employed) || [];
    if ((detail && Object.keys(detail).length) || business.length) {
      // From the fact find: annual amounts by Quickli income type.
      for (const [k, v] of Object.entries(detail || {})) {
        row[k] = v;
      }
      // One year's bonus is used as is; two years let the lender average them.
      if (row.recent_year_bonus || row.previous_year_bonus) row.use_simple_bonus = !row.previous_year_bonus;
      for (const b of business) {
        self_employed_income.push({
          id: `crm-business-${a.id}-${self_employed_income.length + 1}`, name: b.business || `${a.first_name}'s business`, entity_type: b.entity || 'sole_trader', calculation_method: 'lender_default',
          most_recent_year_details: { net_profit_before_tax: b.recent || 0, personal_wages_before_tax: applicants.map((x) => (x.id === a.id ? b.wages_recent || 0 : 0)) },
          previous_year_details: { net_profit_before_tax: b.previous || 0, personal_wages_before_tax: applicants.map((x) => (x.id === a.id ? b.wages_prev || 0 : 0)) },
          applicant_ownership: applicants.map((x) => (x.id === a.id ? 100 : 0)), business_liabilities: [],
        });
      }
      if (business.length) warnings.push(`${a.first_name}'s business profits come from the fact find: add-backs (depreciation, interest and so on) still need entering in Quickli.`);
    } else if (!a.annual_income) warnings.push(`No income recorded for ${a.first_name}.`);
    else if (type === 'self_employed') warnings.push(`${a.first_name} is self-employed: add their business financials in Quickli.`);
    else if (type === 'retired') row.pension = a.annual_income;
    else if (type === 'other') row.other_taxed = a.annual_income;
    else row.payg = a.annual_income;
    return row;
  });

  // Properties already owned, and the one being bought.
  const owned = position.properties.filter((p) => p.status !== 'sold');
  const activeLoans = position.loans.filter((n) => n.status === 'active');
  const securities = owned.map((p) => ({
    id: `crm-security-${p.id}`,
    address: p.address,
    ...(postcodeOf(p) ? { postcode: postcodeOf(p) } : {}),
    property_purpose: p.usage === 'investment' ? 'investment' : 'owner_occupied',
    property_type: PROPERTY_TYPE[p.property_type] || 'other',
    transaction_type: activeLoans.some((n) => n.security_ids.includes(p.id)) ? 'owns_with_mortgage' : 'owns_outright',
    value: p.current_value || null,
    ...(p.usage === 'investment' ? { rental_type: 'residential', weekly_rental_income: p.rental_income_weekly || 0 } : {}),
    applicant_ownership: ownership(p.contact_id, p.co_owner_id),
  }));
  const purchasing = PURCHASES.includes(deal.loan_purpose);
  let dealSecurityId = null;
  if (purchasing) {
    dealSecurityId = 'crm-security-purchase';
    securities.push({
      id: dealSecurityId,
      ...(deal.property_address ? { address: deal.property_address } : {}),
      property_purpose: deal.loan_purpose === 'investment' ? 'investment' : 'owner_occupied',
      property_type: deal.loan_purpose === 'construction' ? 'land' : 'house',
      transaction_type: 'purchasing',
      value: deal.property_value || null,
      ...(deal.loan_purpose === 'investment' ? { rental_type: 'residential', weekly_rental_income: 0 } : {}),
      applicant_ownership: applicants.map(() => Math.round(100 / applicants.length)),
    });
    if (!deal.property_value) warnings.push('No purchase price on the deal.');
    if (deal.loan_purpose === 'investment') warnings.push('Add the expected rent for the investment property in Quickli.');
  } else {
    const match = owned.find((p) => deal.property_address && normAddr(p.address) === normAddr(deal.property_address));
    dealSecurityId = match ? `crm-security-${match.id}` : null;
  }

  // Existing home loans; any secured by the property being refinanced are being paid out.
  const refinancing = deal.loan_purpose === 'refinance';
  const existing_home_loans = [];
  const liabilities = [];
  const links = [];
  for (const n of activeLoans) {
    if (n.deal_id === deal.id) continue;
    if (HOME_LOANS.includes(n.loan_type)) {
      const secIds = n.security_ids.filter((id) => owned.some((p) => p.id === id)).map((id) => `crm-security-${id}`);
      const investment = n.loan_type === 'investment_loan' || n.security_ids.some((id) => owned.find((p) => p.id === id)?.usage === 'investment');
      const paidOut = refinancing && dealSecurityId && secIds.includes(dealSecurityId);
      existing_home_loans.push({
        id: `crm-loan-${n.id}`,
        ignore: Boolean(paidOut),
        product_type: productType(n.rate_type, yearsUntil(n.fixed_expiry_date)),
        loan_type: investment ? 'investment' : 'owner_occupied',
        lender: n.lender_display || '',
        loan_amount: num(n.limit_amount) ?? num(n.balance),
        loan_balance: num(n.balance) ?? num(n.limit_amount),
        actual_rate: num(n.interest_rate),
        term: num(n.loan_term_years) || 30,
        interest_only_period: n.repayment_type === 'io' ? Math.ceil(yearsUntil(n.io_expiry_date)) || 1 : 0,
        ...(monthly(n) ? { monthly_repayment: monthly(n) } : {}),
        is_tax_deductible: investment,
        ...(investment ? { applicant_tax_benefit: ownership(n.contact_id, n.co_borrower_id) } : {}),
      });
      if (secIds.length) links.push({ id: `crm-link-loan-${n.id}`, which_security_ids: secIds, which_existing_home_loan_ids: [`crm-loan-${n.id}`] });
      if (!n.interest_rate) warnings.push(`No interest rate on the ${n.lender_display} loan.`);
    } else if (n.loan_type === 'smsf') {
      // Held by the super fund, not the applicants personally.
      warnings.push(`The ${n.lender_display} SMSF loan isn't sent: it's the super fund's debt. Add it in Quickli if the lender wants it counted.`);
    } else if (n.loan_type === 'hecs') {
      const owner = applicants.find((a) => a.id === n.contact_id) || applicants[0];
      hecs.set(owner.id, (hecs.get(owner.id) || 0) + (num(n.balance) || 0));
    } else {
      liabilities.push({
        id: `crm-liability-${n.id}`,
        loan_type: LIABILITY_TYPE[n.loan_type] || 'other',
        lender: n.lender_display || '',
        limit: num(n.limit_amount) ?? num(n.balance),
        ...(monthly(n) ? { monthly_repayment: monthly(n) } : {}),
        ...(num(n.interest_rate) ? { rate: num(n.interest_rate) } : {}),
      });
    }
  }
  for (const row of income) {
    const balance = hecs.get(Number(row.id.replace('crm-income-', '')));
    if (balance !== undefined) Object.assign(row, { HECS: true, HECS_balance: balance });
  }

  // The new loan.
  if (!deal.loan_amount) warnings.push('No loan amount on the deal.');
  const proposed = {
    id: `crm-proposed-${deal.id}`,
    product_type: productType(deal.rate_type, yearsUntil(deal.fixed_expiry_date)),
    loan_type: deal.loan_purpose === 'investment' ? 'investment' : 'owner_occupied',
    loan_amount: num(deal.loan_amount),
    term: num(deal.loan_term_years) || 30,
    interest_only_period: deal.repayment_type === 'io' ? 5 : 0,
    use_generic_rate: false,
    is_tax_deductible: deal.loan_purpose === 'investment',
    ...(deal.loan_amount && deal.property_value ? { lvr: Math.round((deal.loan_amount / deal.property_value) * 10000) / 100 } : {}),
  };
  if (deal.repayment_type === 'io') warnings.push('Interest-only period set to 5 years: change it in Quickli if needed.');
  if (deal.rate_type === 'fixed' && !deal.fixed_expiry_date) warnings.push('Fixed rate term set to 2 years: change it in Quickli if needed.');
  if (dealSecurityId) links.push({ id: `crm-link-proposed-${deal.id}`, which_security_ids: [dealSecurityId], which_proposed_home_loan_ids: [proposed.id] });
  else if (!purchasing) warnings.push('The property being refinanced isn\'t in the mortgage tracker, so link the new loan to its security in Quickli.');

  const scenario = {
    households, income, self_employed_income, securities, home_loan_security_links: links,
    proposed_home_loans: [proposed], existing_home_loans, liabilities, living_expenses,
    additional_info: { source: 'EFH CRM', crm_deal_id: deal.id },
  };
  const money = (v) => (v ? `$${Math.round(v).toLocaleString('en-AU')}` : '—');
  const summary = {
    borrowers: applicants.map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ')),
    household: `${status === 'single' ? 'Single' : status === 'married' ? 'Married' : 'De facto'}, ${dependants} dependant${dependants === 1 ? '' : 's'}${postcode ? `, postcode ${postcode}` : ''}`,
    income: income.map((r) => `${r.name}: ${money(r.payg ?? r.pension ?? r.other_taxed)}${r.payg ? ' PAYG' : r.pension ? ' pension' : r.other_taxed ? ' other' : ''}${r.HECS ? ' (HECS)' : ''}`),
    properties: securities.map((s) => `${s.address || 'Purchase property'}: ${money(s.value)} (${s.transaction_type === 'purchasing' ? 'buying' : s.property_purpose === 'investment' ? 'investment' : 'home'})`),
    existing_loans: existing_home_loans.map((l) => `${l.lender || 'Loan'}: ${money(l.loan_balance)} at ${l.actual_rate ?? '?'}%${l.ignore ? ' (being refinanced)' : ''}`),
    debts: liabilities.map((l) => `${l.lender || l.loan_type}: ${money(l.limit)} ${l.loan_type.replace('_', ' ')}`),
    new_loan: `${money(proposed.loan_amount)} ${proposed.loan_type === 'investment' ? 'investment' : 'owner-occupied'}, ${proposed.term} years, ${proposed.product_type.replace(/_/g, ' ')}${proposed.lvr ? `, LVR ${proposed.lvr}%` : ''}`,
  };
  return { scenario, summary, warnings, description: `${summary.borrowers.join(' & ')} – ${deal.title}`.slice(0, 200) };
}

// ---- Linking a deal to a scenario -----------------------------------------------------------------

const scenarioIdOf = (r) => String(r?.scenarioId ?? r?.scenario_id ?? r?.id ?? r?._id ?? r?.data?.id ?? r?.scenario?.id ?? '') || null;
const readinessOf = (r) => {
  const c = r?.calcReadinessCheck || r?.calc_readiness_check || r?.data?.calcReadinessCheck;
  return c && typeof c.ready === 'boolean' ? { ready: c.ready, issues: Array.isArray(c.issues) ? c.issues.filter((x) => typeof x === 'string').slice(0, 30) : [] } : null;
};

function linkFor(dealId) {
  const row = db.one('SELECT q.*, u.name AS pushed_by_name FROM quickli_scenarios q LEFT JOIN users u ON u.id = q.pushed_by WHERE q.deal_id = ?', dealId);
  if (!row) return null;
  const url = config().scenarioUrl;
  return {
    scenario_id: row.scenario_id,
    url: url ? url.replace('{id}', encodeURIComponent(row.scenario_id)) : null,
    pushed_at: row.pushed_at, pushed_by_name: row.pushed_by_name, updated_at: row.updated_at,
    calc_ready: row.calc_ready === null ? null : Boolean(row.calc_ready),
    issues: row.issues ? JSON.parse(row.issues) : [],
    results: row.results ? JSON.parse(row.results) : null,
  };
}

function store(dealId, scenarioId, response, userId, { pushed = false } = {}) {
  const ready = readinessOf(response);
  const fields = {
    scenario_id: scenarioId,
    calc_ready: ready ? (ready.ready ? 1 : 0) : null,
    issues: JSON.stringify(ready?.issues || []),
    response: JSON.stringify(response ?? null).slice(0, 200000),
    updated_at: nowIso(),
    ...(pushed ? { pushed_at: nowIso(), pushed_by: userId } : {}),
  };
  if (db.one('SELECT 1 FROM quickli_scenarios WHERE deal_id = ?', dealId)) {
    const cols = Object.keys(fields);
    db.run(`UPDATE quickli_scenarios SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE deal_id = ?`, ...cols.map((c) => fields[c]), dealId);
  } else db.insert('quickli_scenarios', { deal_id: dealId, ...fields });
}

// Sends the deal to Quickli: a new scenario, or an update to the linked one.
async function push(dealId, userId) {
  const built = buildScenario(dealId);
  const existing = linkFor(dealId);
  const body = { description: built.description, scenario: built.scenario };
  const response = existing
    ? await request(userId, 'PUT', `/api/v3/scenarios/${encodeURIComponent(existing.scenario_id)}`, body)
    : await request(userId, 'POST', '/api/v3/scenarios', body);
  const id = scenarioIdOf(response) || existing?.scenario_id;
  if (!id) throw new HttpError(502, 'Quickli created the scenario but didn\'t say its ID. Find it in Quickli and use "Link an existing scenario".');
  store(dealId, id, response, userId, { pushed: true });
  const deal = db.one('SELECT contact_id FROM deals WHERE id = ?', dealId);
  db.insert('activities', { contact_id: deal.contact_id, deal_id: dealId, user_id: userId, type: 'system', body: `${existing ? 'Updated' : 'Created'} Quickli scenario ${id}` });
  return { ...linkFor(dealId), warnings: built.warnings };
}

async function link(dealId, scenarioId, userId) {
  const id = String(scenarioId || '').trim().replace(/^.*\/(?=[^/]+$)/, '');
  if (!/^[\w-]{4,100}$/.test(id)) throw new HttpError(400, 'Paste the scenario ID (or the scenario\'s link) from Quickli');
  const response = await request(userId, 'GET', `/api/v3/scenarios/${encodeURIComponent(id)}`);
  store(dealId, id, response, userId);
  return linkFor(dealId);
}

async function refresh(dealId, userId) {
  const existing = linkFor(dealId);
  if (!existing) throw new HttpError(400, 'This deal isn\'t linked to a Quickli scenario yet');
  const response = await request(userId, 'GET', `/api/v3/scenarios/${encodeURIComponent(existing.scenario_id)}`);
  store(dealId, existing.scenario_id, response, userId);
  return linkFor(dealId);
}

function unlink(dealId) {
  db.run('DELETE FROM quickli_scenarios WHERE deal_id = ?', dealId);
}

// The servicing result the broker records from Quickli.
function saveResults(dealId, input = {}, userId = null) {
  if (!db.one('SELECT 1 FROM quickli_scenarios WHERE deal_id = ?', dealId)) throw new HttpError(400, 'Link the deal to a Quickli scenario first');
  const n = (v, label) => {
    if (v === null || v === undefined || v === '') return null;
    const x = Number(String(v).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(x)) throw new HttpError(400, `${label} must be a number`);
    return x;
  };
  const results = {
    max_borrowing: n(input.max_borrowing, 'Maximum borrowing'),
    lenders_passing: n(input.lenders_passing, 'Lenders that pass'),
    best_lender: String(input.best_lender || '').trim().slice(0, 100) || null,
    surplus: n(input.surplus, 'Monthly surplus'),
    notes: String(input.notes || '').trim().slice(0, 2000) || null,
    recorded_at: nowIso(),
    recorded_by: userId,
  };
  db.run('UPDATE quickli_scenarios SET results = ?, updated_at = ? WHERE deal_id = ?', JSON.stringify(results), nowIso(), dealId);
  return linkFor(dealId);
}

module.exports = {
  config, configured, saveConfig, generateKey, importKey, tokenStatus, verifyToken, test, disconnect, sign, signingBody,
  buildScenario, push, link, refresh, unlink, saveResults, linkFor, request,
};
