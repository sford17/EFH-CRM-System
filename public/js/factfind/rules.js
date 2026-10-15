// Online fact find: options, the adaptive document checklist and the answer
// summary. Shared by the client's fact-find page, the broker's review page and
// the server (which loads this module too), so the rules live in one place.
// Income and living-expense categories use Quickli's names, so a completed
// fact find flows straight into a Quickli scenario.

export const TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Mx'];
export const MARITAL = [['single', 'Single'], ['married', 'Married'], ['de_facto', 'De facto'], ['separated', 'Separated'], ['divorced', 'Divorced'], ['widowed', 'Widowed']];
export const RESIDENCY = [['citizen', 'Australian citizen'], ['nz_citizen', 'New Zealand citizen'], ['permanent_resident', 'Permanent resident'], ['visa', 'Temporary visa']];
export const LIVING = [['own_mortgage', 'I own it, with a mortgage'], ['own_outright', 'I own it outright'], ['renting', 'Renting'], ['boarding', 'Boarding'], ['with_parents', 'Living with parents'], ['employer', 'Provided by my employer'], ['other', 'Other']];
export const EMPLOYMENT = [
  ['full_time', 'Full-time employee'], ['part_time', 'Part-time employee'], ['casual', 'Casual employee'], ['contract', 'Contractor'],
  ['self_employed', 'Self-employed / business owner'], ['parental_leave', 'On parental leave'], ['retired', 'Retired'],
  ['home_duties', 'Home duties'], ['student', 'Student'], ['unemployed', 'Not working'],
];
export const PAYG = ['full_time', 'part_time', 'casual', 'contract', 'parental_leave'];
export const WORKING = [...PAYG, 'self_employed'];
export const ENTITY = [['sole_trader', 'Sole trader'], ['company', 'Company'], ['trust', 'Trust'], ['partnership', 'Partnership']];
export const FREQ = [['weekly', 'Weekly', 52], ['fortnightly', 'Fortnightly', 26], ['monthly', 'Monthly', 12], ['quarterly', 'Quarterly', 4], ['annually', 'Yearly', 1]];
export const OTHER_INCOME = [
  ['second_job', 'Second job'], ['family_tax_a', 'Family Tax Benefit A'], ['family_tax_b', 'Family Tax Benefit B'], ['parenting_payments', 'Parenting payment'],
  ['carers_income', 'Carer payment or allowance'], ['pension', 'Pension (age, disability or super)'], ['social_security', 'Other Centrelink payment'],
  ['child_maintenance', 'Child support received'], ['interest_income', 'Interest'], ['investment_income', 'Dividends and distributions'],
  ['foreign_income', 'Income from overseas'], ['other_taxed', 'Other taxable income'], ['other_tax_free', 'Other tax-free income'],
];
const CENTRELINK = ['family_tax_a', 'family_tax_b', 'parenting_payments', 'carers_income', 'pension', 'social_security'];
export const PURPOSES = [
  ['buy_home', 'Buy a home to live in'], ['first_home', 'Buy my first home'], ['buy_investment', 'Buy an investment property'],
  ['refinance', 'Refinance my home loan'], ['build', 'Build a home'], ['equity', 'Use my equity (renovate, invest or other)'], ['other', 'Something else'],
];
export const BUYING = ['buy_home', 'first_home', 'buy_investment'];
export const DEPOSIT_SOURCES = [['savings', 'Savings'], ['gift', 'A gift from family'], ['equity', 'Equity in another property'], ['fhog', 'First Home Owner Grant'], ['fhss', 'First Home Super Saver scheme'], ['sale', 'Selling a property'], ['other', 'Other']];
export const REFI_REASONS = [['lower_rate', 'A lower interest rate'], ['lower_repayments', 'Lower repayments'], ['cash_out', 'Access equity / cash out'], ['consolidate', 'Combine debts'], ['fixed_ending', 'My fixed rate is ending'], ['features', 'Better features (offset, redraw)'], ['service', 'Unhappy with my lender'], ['other', 'Other']];
export const EQUITY_USES = [['renovate', 'Renovating'], ['invest', 'Buying an investment'], ['consolidate', 'Paying off other debts'], ['car', 'Buying a car'], ['business', 'Business'], ['other', 'Other']];
export const RATE_PREF = [['variable', 'Variable'], ['fixed', 'Fixed'], ['split', 'Split (part fixed)'], ['unsure', 'Not sure yet']];
export const FEATURES = [['offset', 'Offset account'], ['redraw', 'Redraw'], ['extra_repayments', 'Extra repayments'], ['no_fees', 'No annual fee'], ['package', 'Package discounts']];
export const TIMEFRAME = [['asap', 'As soon as possible'], ['1_3', '1–3 months'], ['3_6', '3–6 months'], ['6_plus', '6+ months'], ['exploring', 'Just exploring']];
export const PROPERTY_TYPES = [['house', 'House'], ['unit', 'Unit / apartment'], ['townhouse', 'Townhouse'], ['land', 'Land'], ['off_the_plan', 'Off the plan']];
export const PROPERTY_USAGE = [['owner_occupied', 'I live in it'], ['investment', 'Investment (rented out)'], ['holiday', 'Holiday home'], ['vacant', 'Vacant land']];
export const ASSET_TYPES = [['savings', 'Savings or transaction account'], ['term_deposit', 'Term deposit'], ['superannuation', 'Superannuation'], ['shares', 'Shares and managed funds'], ['vehicle', 'Car or other vehicle'], ['contents', 'Home contents'], ['business', 'Business'], ['other', 'Other']];
export const LIABILITY_TYPES = [['home_loan', 'Home loan'], ['credit_card', 'Credit card'], ['personal', 'Personal loan'], ['car', 'Car loan or lease'], ['business_loan', 'Business loan'], ['hecs', 'HECS-HELP / student loan'], ['bnpl', 'Buy now, pay later'], ['tax', 'Tax debt'], ['other', 'Other debt']];

// Living expenses, by Quickli category. `when` decides whether to ask.
export const EXPENSES = [
  { key: 'food_and_groceries', label: 'Groceries', hint: 'Food, cleaning and toiletries from the supermarket' },
  { key: 'primary_residence', label: 'Running your home', hint: 'Electricity, gas, water, council rates, repairs', when: (a) => !livesRentFree(a) },
  { key: 'ongoing_rent', label: 'Rent or board', hint: 'Filled in from your living situation', when: (a) => a.applicants.some((p) => ['renting', 'boarding'].includes(p.living_situation)) },
  { key: 'phone_internet_media', label: 'Phone, internet & streaming', hint: 'Mobiles, internet, Netflix, Spotify and so on' },
  { key: 'transport', label: 'Transport', hint: 'Fuel, rego, servicing, tolls, parking, public transport' },
  { key: 'clothing_and_personal_care', label: 'Clothing & personal care', hint: 'Clothes, haircuts, cosmetics, pet care' },
  { key: 'medical_and_health', label: 'Medical & health', hint: 'GP, dentist, pharmacy, gym (not health insurance)' },
  { key: 'recreation_and_holidays', label: 'Recreation & entertainment', hint: 'Eating out, hobbies, sport, holidays, gifts' },
  { key: 'private_health_insurance', label: 'Private health insurance' },
  { key: 'general_insurance', label: 'Home, contents & car insurance' },
  { key: 'life_accident_illness_insurance', label: 'Life, income protection & TPD insurance' },
  { key: 'childcare', label: 'Childcare', hint: 'After any Child Care Subsidy', when: (a) => dependants(a) > 0 },
  { key: 'public_education', label: 'School costs (public schools)', hint: 'Uniforms, books, excursions, voluntary fees', when: (a) => dependants(a) > 0 },
  { key: 'private_non_government_school_fees', label: 'Private school fees', when: (a) => dependants(a) > 0 },
  { key: 'higher_education_and_vocational_training', label: 'Uni, TAFE & professional fees' },
  { key: 'child_support_maintenance_payments', label: 'Child support you pay' },
  { key: 'strata_fees_and_body_corporate_fees', label: 'Strata / body corporate & land tax on your home', when: (a) => a.applicants.some((p) => ['own_mortgage', 'own_outright'].includes(p.living_situation)) },
  { key: 'secondary_residence_costs', label: 'Investment & holiday property costs', hint: 'Rates, insurance, strata, repairs and agent fees', when: (a) => (a.properties || []).some((p) => p.usage && p.usage !== 'owner_occupied') },
  { key: 'other', label: 'Other regular expenses', hint: 'Anything else you pay regularly' },
];

// For "request documents only": the broker picks from these, or types their own.
export const DOC_LIBRARY = [
  ['Photo ID (driver licence front and back, or passport)', 'identity'],
  ['Medicare card', 'identity'],
  ['Last 2 payslips', 'income'],
  ['Last 2 years\' income statements (from myGov)', 'income'],
  ['Employment contract or letter of offer', 'income'],
  ['Last 2 years\' personal tax returns and Notices of Assessment', 'income'],
  ['Last 2 years\' business financial statements and tax returns', 'income'],
  ['ATO business portal statement', 'income'],
  ['Centrelink income statement', 'income'],
  ['Last 3 months\' transaction account statements', 'banking'],
  ['Last 3 months\' savings account statements', 'banking'],
  ['Latest credit card statements', 'liabilities'],
  ['Latest personal or car loan statements', 'liabilities'],
  ['Last 6 months\' home loan statements', 'liabilities'],
  ['Latest council rates notice', 'property'],
  ['Current lease or rental statements', 'property'],
  ['Signed contract of sale', 'property'],
  ['Fixed-price building contract and council-approved plans', 'property'],
  ['Gift letter (statutory declaration)', 'banking'],
  ['Visa grant notice', 'identity'],
];

// ---- Helpers ----------------------------------------------------------------------------------------

export const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const FREQ_PER_YEAR = Object.fromEntries(FREQ.map(([k, , n]) => [k, n]));
export const toAnnual = (amount, freq = 'annually') => num(amount) * (FREQ_PER_YEAR[freq] ?? 1);
export const toMonthly = (amount, freq = 'monthly') => toAnnual(amount, freq) / 12;
export const labelOf = (list, key) => list.find(([k]) => k === key)?.[1] || '';
export const yes = (v) => v === 'yes';
export const uid = () => Math.random().toString(36).slice(2, 10);
export const fullName = (p) => [p?.first_name, p?.last_name].filter(Boolean).join(' ');
const today = () => new Date().toISOString().slice(0, 10);

// Months from a 'YYYY-MM' (or date) to now (or to `to`).
export function monthsSince(from, to = today()) {
  const m = /^(\d{4})-(\d{2})/.exec(from || '');
  const t = /^(\d{4})-(\d{2})/.exec(to || '');
  if (!m || !t) return null;
  return Math.max(0, (Number(t[1]) - Number(m[1])) * 12 + Number(t[2]) - Number(m[2]));
}
export function age(dob, on = today()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return null;
  let years = Number(on.slice(0, 4)) - Number(dob.slice(0, 4));
  if (on.slice(5) < dob.slice(5)) years -= 1;
  return years;
}

export const dependants = (a) => Math.max(0, Math.round(num(a.household?.dependants)));
export const isBuying = (a) => BUYING.includes(a.goal?.purpose);
const livesRentFree = (a) => a.applicants.every((p) => ['with_parents', 'employer'].includes(p.living_situation));

// The months of history covered by the current item plus earlier ones.
export function addressMonths(p) {
  let months = monthsSince(p.address_since) ?? 0;
  for (const prev of p.prev_addresses || []) months += monthsSince(prev.from, prev.to || p.address_since) ?? 0;
  return months;
}
export function jobMonths(p) {
  const jobs = p.jobs || [];
  let months = 0;
  for (const [i, j] of jobs.entries()) {
    if (!WORKING.includes(j.type)) continue;
    months += monthsSince(j.start, i === 0 ? undefined : (j.end || undefined)) ?? 0;
  }
  return months;
}
export const ADDRESS_YEARS = 3;
export const JOB_YEARS = 2;
export const needsPrevAddress = (p) => Boolean(p.address_since) && monthsSince(p.address_since) < ADDRESS_YEARS * 12;
export const needsPrevJob = (p) => {
  const cur = p.jobs?.[0];
  return Boolean(cur && WORKING.includes(cur.type) && cur.start) && monthsSince(cur.start) < JOB_YEARS * 12;
};

// The applicant's annual income in Quickli's categories.
export function incomeOf(p) {
  const out = {};
  const add = (k, v) => { if (num(v)) out[k] = (out[k] || 0) + num(v); };
  for (const [i, j] of (p.jobs || []).entries()) {
    if (i > 0 && !yes(j.current)) continue;
    if (PAYG.includes(j.type)) {
      add(j.type === 'casual' ? 'casual' : 'payg', toAnnual(j.base, j.base_freq || 'annually'));
      add('overtime', j.overtime);
      add('commission', j.commission);
      add('recent_year_bonus', j.bonus);
      add('previous_year_bonus', j.bonus_prev);
      add('car_allowance', j.allowances);
    }
  }
  for (const o of p.other_income || []) add(o.type, toAnnual(o.amount, o.freq));
  return out;
}
export function selfEmployedOf(p) {
  return (p.jobs || []).filter((j, i) => j.type === 'self_employed' && (i === 0 || yes(j.current))).map((j) => ({
    business: j.business_name || '', entity: j.entity || 'sole_trader', abn: j.abn || '',
    recent: num(j.profit_recent), previous: num(j.profit_prev), wages_recent: num(j.wages_recent), wages_prev: num(j.wages_prev),
  }));
}
export function totalIncome(p) {
  const inc = incomeOf(p);
  const se = selfEmployedOf(p).reduce((s, b) => s + (b.recent || b.previous) + b.wages_recent, 0);
  return Object.entries(inc).filter(([k]) => k !== 'previous_year_bonus').reduce((s, [, v]) => s + v, 0) + se;
}
// Monthly living expenses by category (rent comes from the living section).
export function expensesMonthly(a) {
  const out = {};
  for (const e of EXPENSES) {
    if (e.when && !e.when(a)) continue;
    const v = a.expenses?.[e.key];
    const m = toMonthly(v?.amount, v?.freq || 'monthly');
    if (m) out[e.key] = Math.round(m * 100) / 100;
  }
  if (!out.ongoing_rent) {
    const rent = a.applicants.filter((p) => ['renting', 'boarding'].includes(p.living_situation)).reduce((s, p) => s + toMonthly(p.rent_amount, p.rent_freq || 'weekly'), 0);
    if (rent) out.ongoing_rent = Math.round(rent * 100) / 100;
  }
  return out;
}

export function emptyAnswers() {
  return {
    applying: 'single',
    applicants: [{ id: uid(), jobs: [{ id: uid() }], prev_addresses: [], other_income: [] }],
    household: { dependants: '', dependant_ages: [] },
    goal: {}, properties: [], assets: [], liabilities: [], expenses: {}, declaration: {},
  };
}

// Fills any missing pieces so the page and server can rely on the shape.
export function normalise(a) {
  const base = emptyAnswers();
  const out = { ...base, ...(a && typeof a === 'object' ? a : {}) };
  out.applicants = (Array.isArray(out.applicants) && out.applicants.length ? out.applicants : base.applicants).slice(0, 2)
    .map((p) => ({ prev_addresses: [], other_income: [], ...p, id: p.id || uid(), jobs: Array.isArray(p.jobs) && p.jobs.length ? p.jobs : [{ id: uid() }] }));
  for (const k of ['properties', 'assets', 'liabilities']) out[k] = Array.isArray(out[k]) ? out[k] : [];
  for (const k of ['household', 'goal', 'expenses', 'declaration']) out[k] = out[k] && typeof out[k] === 'object' ? out[k] : {};
  return out;
}

// ---- Documents --------------------------------------------------------------------------------------

// The documents to ask for, worked out from the answers.
export function documentsFor(raw) {
  const a = normalise(raw);
  const docs = [];
  const seen = new Set();
  const add = (key, label, extra = {}) => {
    if (seen.has(key)) return;
    seen.add(key);
    docs.push({ key, label, ...extra });
  };
  const joint = a.applicants.length > 1;
  const purpose = a.goal.purpose;
  for (const p of a.applicants) {
    const who = joint ? (p.first_name || 'Applicant') : '';
    add(`id-${p.id}`, 'Photo ID: driver licence (front and back) or passport', { who, category: 'identity' });
    // Temporary visa holders often don't have Medicare.
    if (p.residency === 'visa') add(`visa-${p.id}`, 'Passport and visa grant notice', { who, category: 'identity' });
    else add(`medicare-${p.id}`, 'Medicare card', { who, category: 'identity' });
    let paysIntoAccount = false;
    for (const [i, j] of (p.jobs || []).entries()) {
      if (i > 0 && !yes(j.current)) continue;
      const at = j.employer ? ` from ${j.employer}` : '';
      if (PAYG.includes(j.type)) {
        paysIntoAccount = true;
        add(`payslips-${j.id}`, j.type === 'parental_leave' ? `Last 2 payslips${at} before your leave, and a letter confirming your return-to-work date and hours` : `Last 2 payslips${at}`, { who, category: 'income' });
        if (j.type === 'contract' || (monthsSince(j.start) ?? 99) < 6) add(`contract-${j.id}`, `Employment contract or letter of offer${at}`, { who, category: 'income' });
        if (j.type === 'casual' || j.type === 'contract' || num(j.bonus) || num(j.commission) || num(j.overtime)) {
          add(`income-statement-${p.id}`, 'Last 2 years\' income statements (from myGov, ATO section)', { who, category: 'income' });
        }
      } else if (j.type === 'self_employed') {
        paysIntoAccount = true;
        const biz = j.business_name ? ` for ${j.business_name}` : '';
        add(`tax-${p.id}`, 'Last 2 years\' personal tax returns and Notices of Assessment', { who, category: 'income' });
        add(`financials-${j.id}`, `Last 2 years' business financial statements${['company', 'trust', 'partnership'].includes(j.entity) ? ' and business tax returns' : ''}${biz}`, { who, category: 'income' });
        add(`ato-${j.id}`, `ATO business portal statement (integrated client account)${biz}`, { who, category: 'income' });
      } else if (j.type === 'retired' && !(p.other_income || []).some((o) => CENTRELINK.includes(o.type))) {
        add(`retirement-${p.id}`, 'Latest superannuation or pension statement', { who, category: 'income' });
      }
    }
    for (const o of p.other_income || []) {
      if (CENTRELINK.includes(o.type)) add(`centrelink-${p.id}`, 'Centrelink income statement (less than 30 days old)', { who, category: 'income' });
      else if (o.type === 'child_maintenance') add(`child-support-${p.id}`, 'Child support assessment or court order', { who, category: 'income' });
      else if (o.type === 'second_job') add(`payslips2-${p.id}`, 'Last 2 payslips from your second job', { who, category: 'income' });
      else if (o.type === 'foreign_income') add(`foreign-${p.id}`, 'Evidence of your overseas income (payslips or tax return)', { who, category: 'income' });
    }
    if (paysIntoAccount) add(`salary-account-${p.id}`, 'Last 3 months\' statements for the account your pay goes into', { who, category: 'banking' });
  }
  const buying = isBuying(a);
  for (const s of a.assets) {
    if (['savings', 'term_deposit'].includes(s.type) && num(s.value) > 0) {
      add(`asset-${s.id}`, `Last 3 months' statements: ${[s.institution, labelOf(ASSET_TYPES, s.type).toLowerCase()].filter(Boolean).join(' ')}${buying ? ' (shows your savings for the deposit)' : ''}`, { category: 'banking' });
    } else if (s.type === 'shares' && num(s.value) > 0 && buying) {
      add(`asset-${s.id}`, `Latest holding statement: ${s.institution || 'shares'}`, { category: 'banking' });
    }
  }
  const sources = a.goal.deposit_sources || [];
  if (buying && sources.includes('gift')) add('gift-letter', 'Gift letter (statutory declaration) from the person giving you the gift', { category: 'banking' });
  if (buying && sources.includes('fhss')) add('fhss', 'First Home Super Saver determination from the ATO', { category: 'banking' });
  if (buying && sources.includes('sale')) add('sale-contract', 'Contract of sale for the property you\'re selling', { category: 'property' });
  for (const p of a.properties) {
    const where = p.address ? ` for ${p.address.split(',')[0]}` : '';
    if (p.usage === 'investment') add(`lease-${p.id}`, `Current lease or last 3 months' rental statements${where}`, { category: 'property' });
    if (['refinance', 'equity'].includes(purpose)) add(`rates-${p.id}`, `Latest council rates notice${where}`, { category: 'property' });
  }
  for (const l of a.liabilities) {
    const lender = l.lender ? `${l.lender} ` : '';
    if (l.type === 'home_loan') {
      add(`liab-${l.id}`, ['refinance', 'equity'].includes(purpose) ? `Last 6 months' statements for your ${lender}home loan` : `Latest statement for your ${lender}home loan`, { category: 'liabilities' });
    } else if (['credit_card', 'personal', 'car', 'bnpl', 'other'].includes(l.type)) {
      add(`liab-${l.id}`, `Latest statement for your ${lender}${labelOf(LIABILITY_TYPES, l.type).toLowerCase()}`, { category: 'liabilities' });
    } else if (l.type === 'tax') {
      add(`liab-${l.id}`, 'ATO statement or payment plan for your tax debt', { category: 'liabilities' });
    }
  }
  if (buying && yes(a.goal.property_found) && yes(a.goal.contract_signed)) add('contract-of-sale', 'Signed contract of sale', { category: 'property' });
  if (purpose === 'build') {
    add('building-contract', 'Fixed-price building contract', { category: 'property' });
    add('plans', 'Council-approved plans and specifications', { category: 'property' });
    if (!yes(a.goal.land_owned)) add('land-contract', 'Contract of sale for the land', { category: 'property' });
  }
  const cashOut = purpose === 'equity' || (purpose === 'refinance' && (a.goal.refi_reasons || []).includes('cash_out'));
  if (cashOut && (a.goal.equity_uses || []).includes('renovate')) add('quotes', 'Builder\'s quotes for the renovation', { category: 'property' });
  add('other', 'Anything else you\'d like to share (optional)', { category: 'other', optional: true });
  return docs;
}

// ---- Summary (client review step, broker review page, notification email) ---------------------------

const money = (v) => (v === '' || v === undefined || v === null ? '' : `$${Math.round(num(v)).toLocaleString('en-AU')}`);
const freqMoney = (amount, freq) => (num(amount) ? `${money(amount)} ${labelOf(FREQ, freq || 'monthly').toLowerCase()}` : '');
const ym = (v) => {
  const m = /^(\d{4})-(\d{2})/.exec(v || '');
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
};
const dmy = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? `${v.slice(8)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '');
const list = (opts, keys) => (keys || []).map((k) => labelOf(opts, k)).filter(Boolean).join(', ');
const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '');
const rows = (pairs) => pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false);

export function summarise(raw) {
  const a = normalise(raw);
  const sections = [];
  const joint = a.applicants.length > 1;
  const nameOf = (owner) => (owner === 'joint' ? 'Joint' : fullName(a.applicants.find((p) => p.id === owner)) || '');

  sections.push({
    title: joint ? 'About you both' : 'About you',
    groups: a.applicants.map((p) => ({
      heading: fullName(p) || 'Applicant',
      rows: rows([
        ['Name', [p.title, p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ')],
        ['Date of birth', dmy(p.dob) + (age(p.dob) !== null ? ` (age ${age(p.dob)})` : '')],
        ['Mobile', p.mobile], ['Email', p.email],
        ['Relationship status', labelOf(MARITAL, p.marital_status)],
        ['Residency', labelOf(RESIDENCY, p.residency) + (p.residency === 'visa' ? ` (subclass ${p.visa_subclass || '?'}${p.visa_expiry ? `, expires ${dmy(p.visa_expiry)}` : ''})` : '')],
        ['Address', [p.address, p.suburb, p.state, p.postcode].filter(Boolean).join(', ')],
        ['Living situation', labelOf(LIVING, p.living_situation) + (num(p.rent_amount) ? `, ${freqMoney(p.rent_amount, p.rent_freq || 'weekly')}` : '')],
        ['At this address since', ym(p.address_since)],
        ...(p.prev_addresses || []).map((x, i) => [`Previous address ${i + 1}`, `${x.address || ''}${x.from ? ` (from ${ym(x.from)})` : ''}`]),
      ]),
    })).concat([{
      heading: 'Household',
      rows: rows([
        ['Dependants', a.household.dependants !== '' ? String(dependants(a)) : ''],
        ['Ages', (a.household.dependant_ages || []).filter((x) => x !== '').join(', ')],
      ]),
    }]),
  });

  sections.push({
    title: 'Work and income',
    groups: a.applicants.flatMap((p) => (p.jobs || []).map((j, i) => ({
      heading: `${fullName(p) || 'Applicant'}: ${i === 0 ? 'current' : yes(j.current) ? 'also current' : 'previous'} – ${labelOf(EMPLOYMENT, j.type) || 'not answered'}`,
      rows: rows([
        ['Employer', j.employer], ['Occupation', j.occupation], ['Business', j.business_name], ['Structure', labelOf(ENTITY, j.entity)], ['ABN', j.abn],
        ['Started', ym(j.start)], ['Finished', i > 0 && !yes(j.current) ? ym(j.end) : ''],
        ['Base income', num(j.base) ? freqMoney(j.base, j.base_freq || 'annually') : ''],
        ['Hours per week', j.hours], ['Overtime (yearly)', money(j.overtime || '')], ['Commission (yearly)', money(j.commission || '')],
        ['Bonus (last year)', money(j.bonus || '')], ['Bonus (year before)', money(j.bonus_prev || '')], ['Allowances (yearly)', money(j.allowances || '')],
        ['Net profit, latest year', money(j.profit_recent || '')], ['Net profit, year before', money(j.profit_prev || '')],
        ['Wages paid to you, latest year', money(j.wages_recent || '')],
        ['Return to work', ym(j.return_date)],
      ]),
    })).concat((p.other_income || []).length ? [{
      heading: `${fullName(p) || 'Applicant'}: other income`,
      rows: (p.other_income || []).map((o) => [labelOf(OTHER_INCOME, o.type) || 'Other', freqMoney(o.amount, o.freq || 'annually')]),
    }] : [])),
  });

  const g = a.goal;
  sections.push({
    title: 'What you\'d like to do',
    groups: [{
      heading: labelOf(PURPOSES, g.purpose) || 'Not answered',
      rows: rows([
        ['Found a property', isBuying(a) ? yn(g.property_found) : ''],
        ['Property', g.property_address], ['Property type', labelOf(PROPERTY_TYPES, g.property_type)],
        ['Price', money(g.price || '')], ['Budget', money(g.budget || '')], ['Areas', g.areas],
        ['Contract signed', yn(g.contract_signed)], ['Finance due', dmy(g.finance_date)], ['Settlement', dmy(g.settlement_date)],
        ['Deposit available', money(g.deposit || '')], ['Deposit from', list(DEPOSIT_SOURCES, g.deposit_sources)], ['Gift amount', money(g.gift_amount || '')],
        ['Interested in first home schemes', yn(g.fhb_schemes)],
        ['Reasons', list(REFI_REASONS, g.refi_reasons)], ['Extra to borrow', money(g.cash_out || '')], ['Used for', list(EQUITY_USES, g.equity_uses)],
        ['Land owned', yn(g.land_owned)], ['Land price', money(g.land_price || '')], ['Build price', money(g.build_price || '')], ['Builder', g.builder],
        ['Loan amount wanted', money(g.loan_amount || '')],
        ['Rate preference', labelOf(RATE_PREF, g.rate_pref)], ['Features wanted', list(FEATURES, g.features)],
        ['Interest-only', yn(g.interest_only)], ['Why interest-only', g.io_reason],
        ['Timeframe', labelOf(TIMEFRAME, g.timeframe)],
        ['Expected changes that affect repayments', yn(g.changes)], ['Details', g.changes_details],
        ['Retirement plans', g.retirement_plan],
        ['Anything else', g.notes],
      ]),
    }],
  });

  sections.push({
    title: 'What you own',
    groups: [
      ...a.properties.map((p) => ({
        heading: p.address || 'Property',
        rows: rows([['Worth about', money(p.value || '')], ['Use', labelOf(PROPERTY_USAGE, p.usage)], ['Rent', freqMoney(p.rent, p.rent_freq || 'weekly')], ['Owner', joint ? nameOf(p.owner) : ''], ['Selling it', yn(p.selling)]]),
      })),
      ...(a.assets.length ? [{ heading: 'Other assets', rows: a.assets.map((s) => [`${labelOf(ASSET_TYPES, s.type)}${s.institution ? ` – ${s.institution}` : ''}${joint && s.owner ? ` (${nameOf(s.owner)})` : ''}`, money(s.value || 0)]) }] : []),
    ],
  });

  sections.push({
    title: 'What you owe',
    groups: a.liabilities.length ? a.liabilities.map((l) => ({
      heading: `${labelOf(LIABILITY_TYPES, l.type) || 'Debt'}${l.lender ? ` – ${l.lender}` : ''}`,
      rows: rows([
        ['Owing', money(l.balance || '')], ['Limit', money(l.limit || '')], ['Repayments', freqMoney(l.repayment, l.repayment_freq || 'monthly')],
        ['Interest rate', num(l.rate) ? `${num(l.rate)}%` : ''], ['Rate type', l.type !== 'home_loan' ? '' : l.rate_type === 'fixed' ? `Fixed${l.fixed_expiry ? ` until ${ym(l.fixed_expiry)}` : ''}` : l.rate_type === 'variable' ? 'Variable' : ''],
        ['Secured by', a.properties.find((p) => p.id === l.property)?.address || ''], ['In whose name', joint ? nameOf(l.owner) : ''],
        ['Paying it off with the new loan', yn(l.clearing)],
      ]),
    })) : [{ heading: 'No debts listed', rows: [] }],
  });

  const exp = expensesMonthly(a);
  const total = Object.values(exp).reduce((s, v) => s + v, 0);
  sections.push({
    title: 'Living expenses',
    groups: [{
      heading: `About ${money(total)} a month`,
      rows: EXPENSES.filter((e) => exp[e.key]).map((e) => [e.label, `${money(exp[e.key])} a month`]),
    }],
  });
  return sections;
}

// How far through the client is (for the broker's list).
export const STEPS = [
  ['about', 'About you'], ['home', 'Where you live'], ['work', 'Work & income'], ['goals', 'Your plans'],
  ['assets', 'What you own'], ['debts', 'What you owe'], ['expenses', 'Living expenses'], ['documents', 'Documents'], ['review', 'Review & submit'],
];
