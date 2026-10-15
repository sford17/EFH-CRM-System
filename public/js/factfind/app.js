// The client's online fact find (opened from the private link in their email).
// Questions adapt as they answer: a partner's details appear when applying
// together, previous addresses and jobs only when needed, income questions
// match how they're employed, and the document list is built from their
// answers. Everything saves as they go.
import * as R from './rules.js';

const token = location.pathname.split('/').filter(Boolean).pop();
const root = document.getElementById('ff-app');
let V = null; // what the server sent
let A = null; // the answers
let step = 'about';
let furthest = 0;
let dirty = false;
let saveTimer = null;
let saveText = '';
let required = [];
let showInvalid = false;

// ---- Small helpers ------------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren() with nested lists and blanks removed.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));

async function call(method, path = '', body) {
  const res = await fetch(`/api/public/fact-find/${encodeURIComponent(token)}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
  return data;
}

function toast(message, kind = '') {
  const el = h(`div${kind ? `.${kind}` : ''}`, message);
  document.getElementById('ff-toast').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

const money = (n) => `$${Math.round(n || 0).toLocaleString('en-AU')}`;
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const span = (months) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} year${y === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || '0 months';
};
const keyOf = (() => {
  const ids = new WeakMap();
  let seq = 0;
  return (obj, key) => {
    if (!ids.has(obj)) ids.set(obj, ++seq);
    return `${ids.get(obj)}:${key}`;
  };
})();
const joint = () => A.applicants.length > 1;
const nameOf = (p, i) => p.first_name || (i ? 'Your partner' : 'You');
const whose = (p, i) => (joint() ? `${nameOf(p, i)}'s` : 'Your');

// ---- Saving ---------------------------------------------------------------------------------------

function setSave(text, error = false) {
  saveText = text;
  for (const el of document.querySelectorAll('.ff-save')) {
    el.textContent = text;
    el.classList.toggle('error', error);
  }
}
function changed() {
  if (V.locked) return;
  dirty = true;
  setSave('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}
async function save() {
  clearTimeout(saveTimer);
  if (!dirty || V.locked || V.kind !== 'full') return true;
  dirty = false;
  setSave('Saving…');
  try {
    await call('PUT', '', { answers: A, step: R.STEPS[furthest][0] });
    setSave('✓ All changes saved');
    return true;
  } catch (err) {
    dirty = true;
    setSave(`Not saved: ${err.message}`, true);
    return false;
  }
}
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    save();
    e.preventDefault();
  }
});

// Re-draws the step after an answer changes (keeping the focus where it was).
let renderQueued = false;
function rerender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const k = document.activeElement?.dataset?.k;
    drawCard();
    if (k) document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
  }, 0);
}

// ---- Fields ---------------------------------------------------------------------------------------

function field(label, control, { hint, req, wide, k, group = false } = {}) {
  const invalid = showInvalid && req && required.find((r) => r.k === k && missing(r));
  const head = label ? h('span', label, req ? h('span.req', { 'aria-hidden': 'true' }, '*') : null) : null;
  const hintEl = hint ? h('span.ff-hint', hint) : null;
  if (group) {
    const id = `g${k.replace(/\W/g, '')}`;
    return h(`div.ff-field${wide ? '.wide' : ''}${invalid ? '.invalid' : ''}`, { role: 'group', 'aria-labelledby': id, 'data-field': k },
      head ? h('span', { id }, head) : null, hintEl, control);
  }
  return h(`label.ff-field${wide ? '.wide' : ''}${invalid ? '.invalid' : ''}`, { 'data-field': k }, head, hintEl, control);
}
const missing = (r) => {
  const v = r.obj[r.key];
  return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (r.month && !/^\d{4}-\d{2}$/.test(v));
};
function need(obj, key, label, extra = {}) {
  const k = keyOf(obj, key);
  required.push({ obj, key, k, label, ...extra });
  return k;
}

function input(obj, key, label, o = {}) {
  const k = o.req ? need(obj, key, label) : keyOf(obj, key);
  const el = h(o.multiline ? 'textarea' : 'input', {
    type: o.multiline ? undefined : o.type || 'text', 'data-k': k, autocomplete: o.ac || 'off', inputmode: o.inputmode, placeholder: o.ph,
    maxlength: o.max || (o.multiline ? 2000 : 200), max: o.maxValue, min: o.minValue, rows: o.multiline ? 3 : undefined,
  });
  el.value = obj[key] ?? '';
  el.addEventListener('input', () => {
    obj[key] = el.value;
    changed();
    o.onInput?.();
  });
  el.addEventListener('change', () => {
    obj[key] = el.value.trim();
    changed();
    if (!o.quiet) rerender();
  });
  return field(label, o.money ? h('div.ff-money', el) : el, { ...o, k });
}
const moneyIn = (obj, key, label, o = {}) => input(obj, key, label, { inputmode: 'decimal', money: true, ph: '0', max: 15, ...o });
const numberIn = (obj, key, label, o = {}) => input(obj, key, label, { inputmode: 'decimal', max: 10, ...o });
const dateIn = (obj, key, label, o = {}) => input(obj, key, label, { type: 'date', ...o });

function moneyFreq(obj, key, freqKey, label, o = {}) {
  if (!obj[freqKey]) obj[freqKey] = o.freq || 'monthly';
  const k = o.req ? need(obj, key, label) : keyOf(obj, key);
  const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', maxlength: 15, 'data-k': k, 'aria-label': label });
  amount.value = obj[key] ?? '';
  amount.addEventListener('input', () => { obj[key] = amount.value; changed(); o.onInput?.(); });
  amount.addEventListener('change', () => { obj[key] = amount.value.trim(); changed(); if (!o.quiet) rerender(); });
  const freq = h('select', { 'data-k': keyOf(obj, freqKey), 'aria-label': `${label}: how often` },
    (o.freqs || R.FREQ).map(([v, l]) => h('option', { value: v, selected: obj[freqKey] === v }, l)));
  freq.addEventListener('change', () => { obj[freqKey] = freq.value; changed(); o.onInput?.(); if (!o.quiet) rerender(); });
  return field(label, h('div.ff-pair', h('div.ff-money', amount), freq), { ...o, k });
}

function select(obj, key, label, options, o = {}) {
  const k = o.req ? need(obj, key, label) : keyOf(obj, key);
  const el = h('select', { 'data-k': k },
    h('option', { value: '' }, o.placeholder || 'Choose…'),
    options.map(([v, l]) => h('option', { value: v, selected: String(obj[key] ?? '') === String(v) }, l)));
  el.addEventListener('change', () => {
    obj[key] = el.value;
    o.onSet?.(el.value);
    changed();
    rerender();
  });
  return field(label, el, { ...o, k });
}

// Big tappable buttons (one choice).
function choice(obj, key, label, options, o = {}) {
  const k = o.req ? need(obj, key, label) : keyOf(obj, key);
  const buttons = options.map(([v, l, icon]) => h('button', {
    type: 'button', 'aria-pressed': String(obj[key] === v), 'data-k': `${k}=${v}`,
    onclick: () => {
      if (o.onSet && o.onSet(v) === false) return;
      obj[key] = v;
      changed();
      rerender();
    },
  }, icon ? h('span.ico', { 'aria-hidden': 'true' }, icon) : null, l));
  return field(label, h(`div.ff-choice${o.small ? '.small' : ''}`, buttons), { ...o, k, group: true });
}
const yesNo = (obj, key, label, o = {}) => choice(obj, key, label, [['yes', 'Yes'], ['no', 'No']], { small: true, ...o });

// Chips (pick any).
function multi(obj, key, label, options, o = {}) {
  const k = keyOf(obj, key);
  const list = Array.isArray(obj[key]) ? obj[key] : [];
  const chips = options.map(([v, l]) => h('button.ff-chip', {
    type: 'button', 'aria-pressed': String(list.includes(v)), 'data-k': `${k}=${v}`,
    onclick: () => {
      const cur = Array.isArray(obj[key]) ? obj[key] : [];
      obj[key] = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      o.onToggle?.(v, obj[key].includes(v));
      changed();
      rerender();
    },
  }, l));
  return field(label, h('div.ff-chips', chips), { ...o, k, group: true });
}

// Month and year (stored as YYYY-MM; works in every browser).
function monthIn(obj, key, label, o = {}) {
  const k = o.req ? need(obj, key, label, { month: true }) : keyOf(obj, key);
  const [y = '', m = ''] = String(obj[key] || '').split('-');
  const now = new Date().getFullYear();
  const mSel = h('select', { 'data-k': `${k}:m`, 'aria-label': `${label}: month` }, h('option', { value: '' }, 'Month'),
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((n, i) => h('option', { value: String(i + 1).padStart(2, '0'), selected: m === String(i + 1).padStart(2, '0') }, n)));
  const years = [];
  for (let yr = now + (o.future || 0); yr >= now - (o.back || 60); yr -= 1) years.push(yr);
  const ySel = h('select', { 'data-k': `${k}:y`, 'aria-label': `${label}: year` }, h('option', { value: '' }, 'Year'), years.map((yr) => h('option', { value: yr, selected: y === String(yr) }, yr)));
  const set = () => { obj[key] = `${ySel.value}-${mSel.value}`; changed(); rerender(); };
  mSel.addEventListener('change', set);
  ySel.addEventListener('change', set);
  return field(label, h('div.ff-month', mSel, ySel), { ...o, k, group: true });
}

function ownerSelect(item, label = 'Whose name is it in?') {
  if (!joint()) return null;
  if (!item.owner) item.owner = 'joint';
  return select(item, 'owner', label, [...A.applicants.map((p, i) => [p.id, nameOf(p, i)]), ['joint', 'Both of us']], { placeholder: 'Choose…' });
}

function items(list, { title, render, empty, removeLabel = 'Remove', remove = (item, i) => list.splice(i, 1) }) {
  if (!list.length) return empty ? h('p.ff-hint', empty) : null;
  return list.map((item, i) => h('div.ff-item',
    h('div.ff-item-head', h('strong', title(item, i)),
      h('button.ff-btn.link.danger', { type: 'button', onclick: () => { remove(item, i); changed(); rerender(); } }, removeLabel)),
    render(item, i)));
}
const grid = (...c) => h('div.ff-grid', c);
const section = (title, ...c) => h('section.ff-section', title ? h('h3', title) : null, c);
const note = (text, kind = '') => h(`div.ff-note${kind ? `.${kind}` : ''}`, text);

// ---- Steps ----------------------------------------------------------------------------------------

const newApplicant = () => ({ id: R.uid(), jobs: [{ id: R.uid() }], prev_addresses: [], other_income: [] });
const hasData = (p) => Boolean(p.first_name || p.last_name || p.email || p.mobile);

function stepAbout() {
  const parts = [
    section('Who\'s applying?',
      choice(A, 'applying', '', [['single', 'Just me', '👤'], ['joint', 'Me and my partner', '👥']], {
        onSet: (v) => {
          if (v === 'joint' && A.applicants.length < 2) A.applicants.push(newApplicant());
          if (v === 'single' && A.applicants.length > 1) {
            // eslint-disable-next-line no-alert
            if (hasData(A.applicants[1]) && !window.confirm('Remove your partner\'s details from this fact find?')) return false;
            A.applicants.splice(1);
          }
          return true;
        },
      })),
  ];
  A.applicants.forEach((p, i) => {
    const mine = !joint() || i === 0;
    parts.push(h('div.ff-person',
      h('h3', h('span.ff-avatar', { 'aria-hidden': 'true' }, (p.first_name || (i ? 'P' : 'Y'))[0].toUpperCase()), joint() ? (i ? 'Your partner' : 'You') : 'Your details'),
      grid(
        select(p, 'title', 'Title', R.TITLES.map((t) => [t, t])),
        input(p, 'first_name', 'First name', { req: true, ac: mine ? 'given-name' : 'off' }),
        input(p, 'middle_name', 'Middle name(s)', { ac: mine ? 'additional-name' : 'off' }),
        input(p, 'last_name', 'Last name', { req: true, ac: mine ? 'family-name' : 'off' }),
        dateIn(p, 'dob', 'Date of birth', { req: true, maxValue: new Date().toISOString().slice(0, 10), ac: mine ? 'bday' : 'off' }),
        input(p, 'mobile', 'Mobile', { req: true, type: 'tel', inputmode: 'tel', ac: mine ? 'tel' : 'off' }),
        input(p, 'email', 'Email', { req: true, type: 'email', inputmode: 'email', ac: mine ? 'email' : 'off', wide: true }),
        select(p, 'marital_status', 'Relationship status', R.MARITAL, { req: true }),
      ),
      choice(p, 'residency', 'Residency', R.RESIDENCY, { req: true }),
      p.residency === 'visa' ? grid(
        input(p, 'visa_subclass', 'Visa subclass', { req: true, ph: 'e.g. 482', inputmode: 'numeric', max: 6 }),
        dateIn(p, 'visa_expiry', 'Visa expiry date', { hint: 'Leave blank if it doesn\'t expire' }),
      ) : null,
      p.residency === 'visa' ? note('Some lenders have extra rules for temporary visa holders. We\'ll find ones that suit.') : null,
    ));
  });
  if (!joint() && ['married', 'de_facto'].includes(A.applicants[0].marital_status)) {
    parts.push(note('If your partner will be on the loan too, choose "Me and my partner" above. If they won\'t, that\'s fine – lenders may still ask about them, and we\'ll let you know.'));
  }
  const deps = R.dependants(A);
  A.household.dependant_ages = (A.household.dependant_ages || []).slice(0, deps);
  parts.push(section('Your household',
    grid(select(A.household, 'dependants', 'How many children or others depend on you financially?', [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => [String(n), n === 8 ? '8 or more' : String(n)]), { req: true, wide: true })),
    deps ? h('div.ff-grid.three', Array.from({ length: deps }, (_, i) => select(A.household.dependant_ages, i, `Age of dependant ${i + 1}`, Array.from({ length: 26 }, (_, n) => [String(n), n === 0 ? 'Under 1' : String(n)])))) : null));
  return parts;
}

function stepHome() {
  const parts = [];
  if (joint()) {
    if (!A.same_address) A.same_address = 'yes';
    parts.push(section(null, yesNo(A, 'same_address', 'Do you both live at the same address?')));
  }
  A.applicants.forEach((p, i) => {
    if (i > 0 && A.same_address === 'yes') return;
    const rents = ['renting', 'boarding'].includes(p.living_situation);
    const covered = R.addressMonths(p);
    parts.push(h('div.ff-person',
      h('h3', joint() && A.same_address !== 'yes' ? `${whose(p, i)} address` : 'Where you live now'),
      grid(
        input(p, 'address', 'Street address', { req: true, wide: true, ac: i === 0 ? 'address-line1' : 'off', ph: 'e.g. 12 Smith Street' }),
        input(p, 'suburb', 'Suburb', { req: true, ac: i === 0 ? 'address-level2' : 'off' }),
        h('div.ff-grid', select(p, 'state', 'State', ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((s) => [s, s]), { req: true }),
          input(p, 'postcode', 'Postcode', { req: true, inputmode: 'numeric', max: 4, ac: i === 0 ? 'postal-code' : 'off' })),
      ),
      choice(p, 'living_situation', 'Do you own or rent it?', R.LIVING, { req: true }),
      rents ? grid(moneyFreq(p, 'rent_amount', 'rent_freq', p.living_situation === 'boarding' ? 'Board you pay' : (joint() ? 'Rent you pay (your share)' : 'Rent you pay'), { freq: 'weekly', req: true, wide: true })) : null,
      ['own_mortgage', 'own_outright'].includes(p.living_situation) ? note('We\'ll ask what it\'s worth (and about the loan) a bit later.') : null,
      grid(monthIn(p, 'address_since', 'When did you move in?', { req: true })),
      R.needsPrevAddress(p) ? [
        note(`Lenders need ${R.ADDRESS_YEARS} years of address history. So far: ${span(covered)}.${covered >= R.ADDRESS_YEARS * 12 ? ' ✓ That\'s enough.' : ' Please add where you lived before.'}`, covered >= R.ADDRESS_YEARS * 12 ? 'ok' : 'warn'),
        items(p.prev_addresses, {
          title: (_, n) => `Previous address ${n + 1}`,
          render: (x) => grid(input(x, 'address', 'Full address', { wide: true, req: true, ph: 'Street, suburb, state, postcode' }), monthIn(x, 'from', 'When did you move in?', { req: true })),
        }),
        covered < R.ADDRESS_YEARS * 12 ? h('div.ff-add', h('button.ff-btn.small.secondary', { type: 'button', onclick: () => { p.prev_addresses.push({ id: R.uid() }); changed(); rerender(); } }, '+ Add a previous address')) : null,
      ] : null,
    ));
  });
  return parts;
}

const PAYG_EXTRAS = [['overtime', 'Overtime'], ['commission', 'Commission'], ['bonus', 'Bonuses'], ['allowances', 'Allowances']];
function jobFields(j, current) {
  const out = [];
  if (R.PAYG.includes(j.type)) {
    out.push(grid(
      input(j, 'employer', 'Employer', { req: current }),
      input(j, 'occupation', 'Job title', { req: current }),
      monthIn(j, 'start', current ? 'When did you start there?' : 'Started', { req: true }),
      current ? null : monthIn(j, 'end', 'Finished', { req: true }),
      j.type === 'casual' || j.type === 'part_time' ? numberIn(j, 'hours', 'Hours per week (average)') : null,
    ));
    if (current) {
      out.push(grid(moneyFreq(j, 'base', 'base_freq', j.type === 'casual' ? 'What you earn before tax' : 'Base salary or wage before tax', { freq: 'annually', req: true, wide: true, hint: 'Not including super' })));
      out.push(multi(j, 'extras', 'Do you also get any of these?', PAYG_EXTRAS));
      const ex = j.extras || [];
      out.push(grid(
        ex.includes('overtime') ? moneyIn(j, 'overtime', 'Overtime, last 12 months') : null,
        ex.includes('commission') ? moneyIn(j, 'commission', 'Commission, last 12 months') : null,
        ex.includes('bonus') ? moneyIn(j, 'bonus', 'Bonus, last financial year') : null,
        ex.includes('bonus') ? moneyIn(j, 'bonus_prev', 'Bonus, the year before') : null,
        ex.includes('allowances') ? moneyIn(j, 'allowances', 'Allowances per year', { hint: 'e.g. car or tool allowance' }) : null,
      ));
      for (const [k] of PAYG_EXTRAS) if (!ex.includes(k)) { delete j[k]; if (k === 'bonus') delete j.bonus_prev; }
      if (j.type === 'parental_leave') {
        out.push(grid(monthIn(j, 'return_date', 'When do you plan to go back to work?', { future: 3, req: true })));
        out.push(note('Lenders usually want a letter from your employer confirming your return date and hours.'));
      }
      if (j.type === 'contract') out.push(note('If you\'re a contractor paid through an ABN, choose "Self-employed" instead.'));
    }
  } else if (j.type === 'self_employed') {
    out.push(grid(
      input(j, 'business_name', 'Business name', { req: true }),
      input(j, 'abn', 'ABN', { inputmode: 'numeric', max: 14 }),
      monthIn(j, 'start', current ? 'When did the business start?' : 'Started', { req: true }),
      current ? null : monthIn(j, 'end', 'Finished', { req: true }),
    ));
    if (current) {
      out.push(choice(j, 'entity', 'How is the business set up?', R.ENTITY, { req: true, small: true }));
      out.push(grid(
        moneyIn(j, 'profit_recent', 'Net profit before tax, last financial year', { req: true }),
        moneyIn(j, 'profit_prev', 'Net profit before tax, the year before'),
        ['company', 'trust'].includes(j.entity) ? moneyIn(j, 'wages_recent', 'Wages the business paid you, last year') : null,
        ['company', 'trust'].includes(j.entity) ? moneyIn(j, 'wages_prev', 'Wages the business paid you, the year before') : null,
      ));
      out.push(note('Your accountant\'s figures are best. We\'ll confirm everything from your tax returns.'));
    }
  } else if (!current) {
    out.push(grid(monthIn(j, 'start', 'From'), monthIn(j, 'end', 'To')));
  }
  return out;
}

function stepWork() {
  return A.applicants.map((p, i) => {
    if (!p.jobs.length) p.jobs.push({ id: R.uid() });
    const cur = p.jobs[0];
    const covered = R.jobMonths(p);
    const prev = p.jobs.slice(1);
    const centrelinkFirst = R.dependants(A) > 0;
    const incomeOptions = centrelinkFirst ? R.OTHER_INCOME : [...R.OTHER_INCOME.filter(([k]) => !['family_tax_a', 'family_tax_b', 'parenting_payments'].includes(k)), ...R.OTHER_INCOME.filter(([k]) => ['family_tax_a', 'family_tax_b', 'parenting_payments'].includes(k))];
    const types = (p.other_income || []).map((o) => o.type);
    return h('div.ff-person',
      h('h3', joint() ? `${whose(p, i)} work and income` : 'Your work and income'),
      choice(cur, 'type', 'What do you do now?', R.EMPLOYMENT, { req: true }),
      jobFields(cur, true),
      R.needsPrevJob(p) ? section('Previous work',
        note(`Lenders need ${R.JOB_YEARS} years of work history. So far: ${span(covered)}.${covered >= R.JOB_YEARS * 12 ? ' ✓ That\'s enough.' : ' Please add your previous job.'}`, covered >= R.JOB_YEARS * 12 ? 'ok' : 'warn'),
        items(prev, {
          title: (j) => j.employer || j.business_name || 'Previous job',
          render: (j) => [choice(j, 'type', 'What was it?', R.EMPLOYMENT.filter(([k]) => R.WORKING.includes(k) || k === 'unemployed' || k === 'student'), { req: true }), jobFields(j, false)],
          remove: (j) => { p.jobs = p.jobs.filter((x) => x !== j); },
        }),
        covered < R.JOB_YEARS * 12 ? h('div.ff-add', h('button.ff-btn.small.secondary', { type: 'button', onclick: () => { p.jobs.push({ id: R.uid(), current: 'no' }); changed(); rerender(); } }, '+ Add a previous job')) : null) : null,
      section('Other income',
        multi({ v: types }, 'v', 'Do you get any other income?', incomeOptions, {
          hint: 'Rent from investment properties goes in "What you own".',
          onToggle: (type, on) => {
            if (on) p.other_income.push({ id: R.uid(), type, freq: ['family_tax_a', 'family_tax_b', 'parenting_payments', 'carers_income', 'pension', 'social_security'].includes(type) ? 'fortnightly' : 'annually' });
            else p.other_income = p.other_income.filter((o) => o.type !== type);
          },
        }),
        grid(p.other_income.map((o) => moneyFreq(o, 'amount', 'freq', R.labelOf(R.OTHER_INCOME, o.type), { req: true, wide: true })))));
  });
}

const PURPOSE_ICONS = { buy_home: '🏡', first_home: '🔑', buy_investment: '📈', refinance: '🔄', build: '🏗️', equity: '💰', other: '💬' };
function stepGoals() {
  const g = A.goal;
  const parts = [section(null, choice(g, 'purpose', 'What would you like to do?', R.PURPOSES.map(([k, l]) => [k, l, PURPOSE_ICONS[k]]), { req: true }))];
  if (R.isBuying(A)) {
    const found = R.yes(g.property_found);
    parts.push(section('The property',
      yesNo(g, 'property_found', 'Have you found a property?', { req: true }),
      found ? grid(
        input(g, 'property_address', 'Property address', { wide: true, req: true }),
        moneyIn(g, 'price', 'Purchase price', { req: true }),
        select(g, 'property_type', 'Type of property', R.PROPERTY_TYPES),
      ) : g.property_found === 'no' ? grid(
        moneyIn(g, 'budget', 'Roughly what\'s your budget?'),
        select(g, 'property_type', 'Type of property', R.PROPERTY_TYPES),
        input(g, 'areas', 'Suburbs or areas you\'re looking in', { wide: true }),
      ) : null,
      found ? yesNo(g, 'contract_signed', 'Have you signed the contract?') : null,
      found && R.yes(g.contract_signed) ? grid(dateIn(g, 'finance_date', 'Finance approval due'), dateIn(g, 'settlement_date', 'Settlement date')) : null,
      found && R.yes(g.contract_signed) ? note('Thanks – we\'ll prioritise this. Please upload the contract in the documents step.') : null));
    parts.push(section('Your deposit',
      grid(moneyIn(g, 'deposit', 'How much do you have for the deposit and costs?', { wide: true, hint: 'Savings and any other funds you\'ll put in' })),
      multi(g, 'deposit_sources', 'Where is it coming from?', R.DEPOSIT_SOURCES),
      (g.deposit_sources || []).includes('gift') ? grid(moneyIn(g, 'gift_amount', 'How much is the gift?')) : null,
      g.purpose === 'first_home' ? yesNo(g, 'fhb_schemes', 'Would you like to hear about first home buyer schemes (like buying with a 5% deposit and no LMI)?') : null));
  } else if (g.purpose === 'refinance') {
    parts.push(section('Your refinance',
      multi(g, 'refi_reasons', 'Why are you looking to refinance?', R.REFI_REASONS),
      (g.refi_reasons || []).includes('cash_out') ? [grid(moneyIn(g, 'cash_out', 'How much extra would you like to borrow?')), multi(g, 'equity_uses', 'What\'s it for?', R.EQUITY_USES)] : null,
      (g.refi_reasons || []).includes('fixed_ending') ? note('Good timing – we\'ll compare your lender\'s new rate with others before it ends.') : null,
      note('Please add the property and the current home loan in the next steps.')));
  } else if (g.purpose === 'equity') {
    parts.push(section('Using your equity', grid(moneyIn(g, 'cash_out', 'How much would you like to borrow?', { req: true })), multi(g, 'equity_uses', 'What\'s it for?', R.EQUITY_USES)));
  } else if (g.purpose === 'build') {
    parts.push(section('Your build',
      yesNo(g, 'land_owned', 'Do you already own the land?', { req: true }),
      grid(g.land_owned === 'no' ? moneyIn(g, 'land_price', 'Land price') : null, moneyIn(g, 'build_price', 'Building contract price'), input(g, 'builder', 'Builder (if chosen)'))));
  }
  if (g.purpose) {
    parts.push(section('Your loan',
      grid(moneyIn(g, 'loan_amount', 'How much would you like to borrow?', { hint: 'If you know – we can work it out with you', wide: true })),
      choice(g, 'rate_pref', 'Interest rate preference', R.RATE_PREF, { small: true }),
      multi(g, 'features', 'Features that matter to you', R.FEATURES),
      yesNo(g, 'interest_only', 'Are you after interest-only repayments?'),
      R.yes(g.interest_only) ? grid(input(g, 'io_reason', 'Why interest-only?', { wide: true, req: true })) : null,
      choice(g, 'timeframe', 'When are you hoping to go ahead?', R.TIMEFRAME, { small: true })));
    const older = A.applicants.some((p) => (R.age(p.dob) ?? 0) >= 50);
    parts.push(section('Looking ahead',
      yesNo(g, 'changes', 'Do you expect any changes in the next few years that could make repayments harder?', { hint: 'For example parental leave, retiring, working fewer hours or a big expense', req: true }),
      R.yes(g.changes) ? grid(input(g, 'changes_details', 'Tell us a bit about it', { multiline: true, wide: true, req: true })) : null,
      older ? grid(input(g, 'retirement_plan', 'When do you plan to retire, and how would you repay the loan if it runs past then?', { multiline: true, wide: true, req: true, hint: 'For example super, downsizing or savings' })) : null,
      grid(input(g, 'notes', 'Anything else you\'d like us to know?', { multiline: true, wide: true }))));
  }
  return parts;
}

function stepAssets() {
  const buying = R.isBuying(A);
  const parts = [section('Property you own',
    h('p.ff-hint', 'Include your home if you own it, and any investment property or land.'),
    items(A.properties, {
      title: (p) => p.address?.split(',')[0] || 'Property',
      empty: 'No property added.',
      render: (p) => [grid(
        input(p, 'address', 'Address', { wide: true, req: true }),
        moneyIn(p, 'value', 'Roughly what\'s it worth?', { req: true }),
        ownerSelect(p),
      ),
      choice(p, 'usage', 'How is it used?', R.PROPERTY_USAGE, { small: true, req: true }),
      p.usage === 'investment' ? grid(moneyFreq(p, 'rent', 'rent_freq', 'Rent received', { freq: 'weekly', req: true, wide: true })) : null,
      buying ? yesNo(p, 'selling', 'Are you selling it?') : null],
    }),
    h('div.ff-add', h('button.ff-btn.small.secondary', { type: 'button', onclick: () => { A.properties.push({ id: R.uid(), usage: '' }); changed(); rerender(); } }, '+ Add a property')))];
  parts.push(section('Savings, super and other assets',
    items(A.assets, {
      title: (s) => R.labelOf(R.ASSET_TYPES, s.type),
      render: (s) => grid(
        input(s, 'institution', s.type === 'vehicle' ? 'Make and model' : ['savings', 'term_deposit', 'superannuation'].includes(s.type) ? (s.type === 'superannuation' ? 'Super fund' : 'Bank') : 'Description'),
        moneyIn(s, 'value', s.type === 'savings' || s.type === 'term_deposit' ? 'Balance' : 'Value', { req: true }),
        ownerSelect(s, 'Whose is it?'),
      ),
    }),
    h('div.ff-add', R.ASSET_TYPES.map(([k, l]) => h('button.ff-btn.small.secondary', { type: 'button', onclick: () => { A.assets.push({ id: R.uid(), type: k }); changed(); rerender(); } }, `+ ${l}`)))));
  if (buying && !A.assets.some((s) => ['savings', 'term_deposit'].includes(s.type))) parts.push(note('Please add the accounts your deposit is in, so we can show lenders your savings.', 'warn'));
  return parts;
}

const DEBT_FIELDS = {
  home_loan: ['lender', 'balance', 'limit', 'repayment', 'rate', 'property'],
  credit_card: ['lender', 'limit', 'balance'],
  personal: ['lender', 'balance', 'repayment'],
  car: ['lender', 'balance', 'repayment'],
  business_loan: ['lender', 'balance', 'limit', 'repayment', 'rate'],
  hecs: ['balance'],
  bnpl: ['lender', 'limit', 'balance'],
  tax: ['balance', 'repayment'],
  other: ['lender', 'balance', 'repayment'],
};
function stepDebts() {
  const consolidating = ['refinance', 'equity'].includes(A.goal.purpose);
  const parts = [section(null,
    h('p.ff-hint', 'Include every loan and card in your name, even if someone else makes the repayments.'),
    items(A.liabilities, {
      title: (l) => `${R.labelOf(R.LIABILITY_TYPES, l.type)}${l.lender ? ` – ${l.lender}` : ''}`,
      render: (l) => {
        const f = DEBT_FIELDS[l.type] || DEBT_FIELDS.other;
        return [grid(
          f.includes('lender') ? input(l, 'lender', l.type === 'bnpl' ? 'Provider (e.g. Afterpay)' : l.type === 'other' ? 'Who is it with?' : 'Lender', { req: true }) : null,
          f.includes('balance') ? moneyIn(l, 'balance', l.type === 'hecs' ? 'Balance owing' : 'Amount owing', { req: l.type !== 'credit_card' }) : null,
          f.includes('limit') ? moneyIn(l, 'limit', 'Limit', { req: l.type === 'credit_card' }) : null,
          f.includes('repayment') ? moneyFreq(l, 'repayment', 'repayment_freq', 'Repayments', { freqs: R.FREQ.filter(([k]) => ['weekly', 'fortnightly', 'monthly'].includes(k)), wide: true }) : null,
          f.includes('rate') ? numberIn(l, 'rate', 'Interest rate (%)', { ph: 'e.g. 6.19' }) : null,
          f.includes('property') && A.properties.length ? select(l, 'property', 'Which property secures it?', A.properties.map((p) => [p.id, p.address || 'Property'])) : null,
          ownerSelect(l),
        ),
        f.includes('rate') ? choice(l, 'rate_type', 'Rate type', [['variable', 'Variable'], ['fixed', 'Fixed']], { small: true }) : null,
        l.rate_type === 'fixed' && f.includes('rate') ? grid(monthIn(l, 'fixed_expiry', 'Fixed rate ends', { future: 10, back: 1 })) : null,
        consolidating && l.type !== 'home_loan' ? yesNo(l, 'clearing', 'Would you like to pay this off with the new loan?') : null];
      },
    }),
    h('div.ff-add', R.LIABILITY_TYPES.map(([k, l]) => h('button.ff-btn.small.secondary', { type: 'button', onclick: () => { A.liabilities.push({ id: R.uid(), type: k, repayment_freq: 'monthly', ...(k === 'home_loan' ? { rate_type: 'variable' } : {}) }); A.no_debts = false; changed(); rerender(); } }, `+ ${l}`))))];
  if (!A.liabilities.length) {
    const box = h('input', { type: 'checkbox', checked: Boolean(A.no_debts), 'data-k': keyOf(A, 'no_debts') });
    box.addEventListener('change', () => { A.no_debts = box.checked; changed(); });
    parts.push(h('label.ff-check', box, h('span', joint() ? 'Neither of us has any debts' : 'I don\'t have any debts')));
  }
  const homeLoans = A.liabilities.filter((l) => l.type === 'home_loan').length;
  if (A.goal.purpose === 'refinance' && !homeLoans) parts.push(note('Please add the home loan you\'d like to refinance.', 'warn'));
  else if (A.applicants.some((p) => p.living_situation === 'own_mortgage') && !homeLoans) parts.push(note('You mentioned a mortgage on your home – please add it here.', 'warn'));
  return parts;
}

function stepExpenses() {
  const total = h('strong');
  const update = () => { total.textContent = `${money(Object.values(R.expensesMonthly(A)).reduce((s, v) => s + v, 0))} a month`; };
  const rows = R.EXPENSES.filter((e) => !e.when || e.when(A)).map((e) => {
    if (!A.expenses[e.key]) A.expenses[e.key] = { amount: '', freq: 'monthly' };
    const ex = A.expenses[e.key];
    const rent = e.key === 'ongoing_rent' ? A.applicants.filter((p) => ['renting', 'boarding'].includes(p.living_situation)).reduce((s, p) => s + R.toMonthly(p.rent_amount, p.rent_freq || 'weekly'), 0) : 0;
    if (e.key === 'ongoing_rent' && !ex.amount && rent) { ex.amount = String(Math.round(rent)); ex.freq = 'monthly'; }
    const ctl = moneyFreq(ex, 'amount', 'freq', e.label, { quiet: true, onInput: update });
    const inner = ctl.querySelector('.ff-pair');
    return h('div.ff-expense', h('div', h('strong', e.label), e.hint ? h('span.ff-hint', e.hint) : null), inner);
  });
  update();
  return [
    note('Don\'t include loan or credit card repayments – we\'ve got those. Lenders compare your figures with a benchmark for your household, so realistic estimates help.'),
    h('div.ff-expenses', rows),
    h('div.ff-total', h('span', 'Total living expenses'), total),
  ];
}

// ---- Documents --------------------------------------------------------------------------------------

const ACCEPT = 'application/pdf,image/*,.heic,.heif,.doc,.docx,.xls,.xlsx';
const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
  r.readAsDataURL(file);
});

async function upload(doc, files, status) {
  if (dirty) await save();
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) { toast(`${file.name} is over 15 MB. Try a smaller scan or photo.`, 'error'); continue; }
    status.textContent = `Uploading ${file.name}…`;
    try {
      const data = await readFile(file);
      const f = await call('POST', '/files', { doc_key: doc.key, filename: file.name, data });
      V.files.push(f);
      toast(`${file.name} uploaded`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  status.textContent = '';
  drawCard();
}

async function removeFile(f) {
  try {
    await call('DELETE', `/files/${f.id}`);
    V.files = V.files.filter((x) => x.id !== f.id);
    drawCard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function docList(docs) {
  const canRemove = V.status !== 'reviewed';
  return docs.map((d) => {
    const mine = V.files.filter((f) => f.doc_key === d.key);
    const picker = h('input.visually-hidden', { type: 'file', multiple: true, accept: ACCEPT, tabindex: '-1', 'aria-hidden': 'true' });
    const status = h('div.ff-hint', { role: 'status' });
    picker.addEventListener('change', () => upload(d, [...picker.files], status));
    const box = h(`div.ff-doc${mine.length ? '.has' : ''}`,
      h('div.ff-doc-icon', { 'aria-hidden': 'true' }, mine.length ? '✅' : '📄'),
      h('div', h('div', d.label), d.who ? h('div.ff-doc-who', `For ${d.who}`) : null, d.note ? h('div.ff-doc-who', d.note) : null, status),
      h('button.ff-btn.small.secondary', { type: 'button', onclick: () => picker.click(), 'aria-label': `${mine.length ? 'Add more files for' : 'Upload'} ${d.label}` }, mine.length ? '+ Add more' : 'Upload'),
      picker,
      mine.length ? h('div.ff-doc-files', mine.map((f) => h('div.ff-file', h('span', `📎 ${f.filename} · ${size(f.size)}`),
        canRemove ? h('button.ff-btn.link.danger', { type: 'button', onclick: () => removeFile(f), 'aria-label': `Remove ${f.filename}` }, 'Remove') : null))) : null);
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); upload(d, [...e.dataTransfer.files], status); });
    return box;
  });
}

function docSummary(docs) {
  const needed = docs.filter((d) => !d.optional);
  const have = needed.filter((d) => V.files.some((f) => f.doc_key === d.key)).length;
  return { needed: needed.length, have };
}

function stepDocuments() {
  const docs = R.documentsFor(A);
  const { needed, have } = docSummary(docs);
  return [
    note(`Based on your answers, we need ${needed} document${needed === 1 ? '' : 's'}. You've uploaded ${have}. Take photos with your phone or upload PDFs – you can also come back and add them later.`, have >= needed ? 'ok' : ''),
    docList(docs),
  ];
}

// ---- Review & submit --------------------------------------------------------------------------------

function issues() {
  const out = [];
  A.applicants.forEach((p, i) => {
    const who = joint() ? `${nameOf(p, i)}: ` : '';
    const miss = [['first_name', 'first name'], ['last_name', 'last name'], ['dob', 'date of birth'], ['mobile', 'mobile'], ['email', 'email']].filter(([k]) => !p[k]).map(([, l]) => l);
    if (miss.length) out.push([`${who}${miss.join(', ')}`, 'about']);
    const home = i > 0 && A.same_address === 'yes' ? A.applicants[0] : p;
    if (!home.address || !home.living_situation) out.push([`${who}current address and living situation`, 'home']);
    if (R.needsPrevAddress(home) && R.addressMonths(home) < R.ADDRESS_YEARS * 12) out.push([`${who}${R.ADDRESS_YEARS} years of address history`, 'home']);
    if (!p.jobs?.[0]?.type) out.push([`${who}employment`, 'work']);
    else if (R.needsPrevJob(p) && R.jobMonths(p) < R.JOB_YEARS * 12) out.push([`${who}${R.JOB_YEARS} years of work history`, 'work']);
  });
  if (!A.goal.purpose) out.push(['what you\'d like to do', 'goals']);
  if (!A.liabilities.length && !A.no_debts) out.push(['your debts (or tick that you have none)', 'debts']);
  if (!Object.values(R.expensesMonthly(A)).some(Boolean)) out.push(['your living expenses', 'expenses']);
  return out;
}

const STEP_OF_SECTION = ['about', 'work', 'goals', 'assets', 'debts', 'expenses'];
function stepReview() {
  const list = issues();
  const docs = R.documentsFor(A);
  const { needed, have } = docSummary(docs);
  const d = A.declaration;
  const business = V.brand.business_name;
  const check = (key, text) => {
    const box = h('input', { type: 'checkbox', checked: Boolean(d[key]), 'data-k': keyOf(d, key) });
    box.addEventListener('change', () => { d[key] = box.checked; changed(); });
    return h('label.ff-check', box, h('span', text));
  };
  const submit = h('button.ff-btn', { type: 'button' }, `Send to ${V.broker.name ? V.broker.name.split(' ')[0] : business}`);
  submit.addEventListener('click', async () => {
    if (!d.privacy || !d.true_and_correct || !String(d.signature || '').trim()) { toast('Please tick both boxes and type your name to sign.', 'error'); return; }
    submit.disabled = true;
    try {
      await save();
      await call('POST', '/submit', { answers: A, step: 'review' });
      V.status = 'submitted';
      V.locked = true;
      dirty = false;
      draw();
      window.scrollTo(0, 0);
    } catch (err) {
      toast(err.message, 'error');
      submit.disabled = false;
    }
  });
  return [
    list.length ? note(h('span', h('strong', 'A few things are missing: '), list.map(([t, s], i) => [i ? '; ' : '', h('button.ff-btn.link', { type: 'button', onclick: () => go(s) }, t)]), '. You can still send it, but your broker may need to ask.'), 'warn') : note('✓ Everything looks complete.', 'ok'),
    needed > have ? note(`${needed - have} document${needed - have === 1 ? ' is' : 's are'} still to upload. You can send this now and add them later using the same link.`, 'warn') : null,
    R.summarise(A).map((s, i) => h('div.ff-review',
      h('div.ff-review-head', h('h3', s.title), h('button.ff-btn.link', { type: 'button', onclick: () => go(STEP_OF_SECTION[i]) }, 'Edit')),
      s.groups.map((g) => [h('h4', g.heading), g.rows.length ? h('dl', g.rows.map(([k, v]) => [h('dt', k), h('dd', v)])) : null]))),
    section('Declaration',
      check('privacy', `I consent to ${business} collecting, using and disclosing my personal information (including to lenders, credit reporting bodies and other service providers) to help me apply for credit, as set out in their privacy policy and credit guide.`),
      check('true_and_correct', 'I declare that the information I\'ve given is true and complete, and I\'ll let my broker know if anything changes before my loan settles.'),
      grid(input(d, 'signature', joint() ? 'Type your full names to sign' : 'Type your full name to sign', { req: true, quiet: true }), h('div.ff-field', h('span', 'Date'), h('div', new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }))))),
    h('div.ff-nav', h('button.ff-btn.secondary', { type: 'button', onclick: () => go(R.STEPS[R.STEPS.length - 2][0]) }, '← Back'), submit),
  ];
}

const STEP_INFO = {
  about: ['About you', 'Let\'s start with who\'s applying.', stepAbout],
  home: ['Where you live', 'Your current address, and where you lived before if you\'ve moved recently.', stepHome],
  work: ['Work & income', 'How you earn your income. We\'ll only ask what\'s relevant to you.', stepWork],
  goals: ['Your plans', 'What you\'d like to achieve, so we can find the right loan.', stepGoals],
  assets: ['What you own', 'Property, savings, super and anything else of value.', stepAssets],
  debts: ['What you owe', 'Loans, cards and other debts.', stepDebts],
  expenses: ['Living expenses', 'Your household\'s regular spending.', stepExpenses],
  documents: ['Documents', 'The documents lenders need, based on your answers.', stepDocuments],
  review: ['Review & submit', 'Check everything, then send it to us.', stepReview],
};

// Things worked out when leaving a step (e.g. a home they own goes into "What you own").
function leaving(key) {
  if (key === 'home') {
    if (joint() && A.same_address === 'yes') {
      const [a, b] = A.applicants;
      for (const k of ['address', 'suburb', 'state', 'postcode', 'living_situation', 'address_since', 'rent_freq']) b[k] = a[k];
      b.prev_addresses = (a.prev_addresses || []).map((x) => ({ ...x }));
      b.rent_amount = '';
    }
    A.applicants.forEach((p, i) => {
      if (!['own_mortgage', 'own_outright'].includes(p.living_situation) || !p.address) return;
      if (i > 0 && A.same_address === 'yes') return;
      const full = [p.address, p.suburb, p.state, p.postcode].filter(Boolean).join(', ');
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      let prop = A.properties.find((x) => norm(x.address).startsWith(norm(p.address)));
      if (!prop) {
        prop = { id: R.uid(), address: full, usage: 'owner_occupied', owner: joint() ? (A.same_address === 'yes' ? 'joint' : p.id) : p.id };
        A.properties.unshift(prop);
      }
      if (p.living_situation === 'own_mortgage' && !A.liabilities.some((l) => l.type === 'home_loan' && l.property === prop.id)) {
        A.liabilities.unshift({ id: R.uid(), type: 'home_loan', property: prop.id, owner: prop.owner, repayment_freq: 'monthly', rate_type: 'variable' });
      }
    });
    changed();
  }
}

function validate() {
  const missingNow = required.filter(missing);
  if (!missingNow.length) return true;
  showInvalid = true;
  drawCard();
  const first = document.querySelector('.ff-field.invalid');
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  first?.querySelector('input,select,textarea,button')?.focus({ preventScroll: true });
  toast(`Please fill in the highlighted field${missingNow.length === 1 ? '' : 's'}.`, 'error');
  return false;
}

async function go(key, { check = false } = {}) {
  if (check && !validate()) return;
  leaving(step);
  showInvalid = false;
  step = key;
  const i = R.STEPS.findIndex(([k]) => k === key);
  if (i > furthest) { furthest = i; dirty = true; }
  await save();
  draw();
  window.scrollTo({ top: 0 });
}

// ---- Page -------------------------------------------------------------------------------------------

function header() {
  const b = V.brand;
  return h('header.ff-header', h('div.ff-header-inner',
    b.logo ? h('img.ff-logo', { src: b.logo, alt: b.business_name }) : h('div.ff-business', b.business_name),
    V.broker.name ? h('div.ff-broker', h('strong', V.broker.name), [V.broker.phone ? h('a', { href: `tel:${V.broker.phone.replace(/\s/g, '')}` }, V.broker.phone) : null, V.broker.phone && V.broker.email ? ' · ' : null, V.broker.email ? h('a', { href: `mailto:${V.broker.email}` }, V.broker.email) : null]) : null));
}
function band(title, text) {
  return h('div.ff-band', h('div.ff-band-inner', h('h1', title), text ? h('p', text) : null));
}
function footer() {
  const b = V.brand;
  return h('footer.ff-footer', h('p', [b.business_name, b.acl, b.phone, b.website].filter(Boolean).join(' · ')),
    h('p', `Your information goes only to ${b.business_name} and is handled under their privacy policy. This link is private to you and works until ${new Date(V.expires_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}.`));
}

let card = null;
function drawCard() {
  required = [];
  const [title, intro, render] = STEP_INFO[step];
  const i = R.STEPS.findIndex(([k]) => k === step);
  const content = render();
  const nav = step === 'review' ? null : h('div.ff-nav',
    i > 0 ? h('button.ff-btn.secondary', { type: 'button', onclick: () => go(R.STEPS[i - 1][0]) }, '← Back') : h('span'),
    h('button.ff-btn', { type: 'button', onclick: () => go(R.STEPS[i + 1][0], { check: true }) }, step === 'documents' ? 'Review & submit →' : 'Save & continue →'));
  fill(card, h('h2', title), h('p.ff-intro', intro), content, nav);
  for (const el of document.querySelectorAll('.ff-steps button')) {
    const k = el.dataset.step;
    el.setAttribute('aria-current', k === step ? 'step' : 'false');
  }
}

function draw() {
  document.title = `${V.kind === 'full' ? 'Fact find' : 'Documents'} – ${V.brand.business_name}`;
  if (V.kind === 'documents') return drawDocumentsOnly();
  if (V.locked) return drawDone();
  card = h('main.ff-card', { id: 'ff-main', tabindex: '-1' });
  const i = R.STEPS.findIndex(([k]) => k === step);
  const steps = h('nav.ff-steps', { 'aria-label': 'Sections' }, h('ol', R.STEPS.map(([k, l], n) => h(`li${n < furthest && k !== step ? '.done' : ''}`,
    h('button', { type: 'button', 'data-step': k, onclick: () => go(k) }, h('span.ff-dot', { 'aria-hidden': 'true' }, n < furthest && k !== step ? '✓' : String(n + 1)), l)))),
  h('div.ff-save', { role: 'status' }, saveText));
  const mobile = h('div.ff-mobile-progress', h('div', 'Step ', h('strong', `${i + 1} of ${R.STEPS.length}`), ` · ${R.STEPS[i][1]}`),
    h('div.ff-progress', h('div')), h('div.ff-save', saveText));
  mobile.querySelector('.ff-progress > div').style.width = `${Math.round(((i + 1) / R.STEPS.length) * 100)}%`;
  const fresh = V.status === 'sent' && furthest === 0;
  fill(root, header(),
    band(fresh ? `Hi ${V.first_name}, let's get started` : `Welcome back, ${V.first_name}`, fresh ? V.message : 'Your answers are saved. Carry on where you left off, or jump to any section.'),
    h('div.ff-layout', steps, h('div', mobile, card)),
    footer());
  drawCard();
}

function drawDone() {
  const docs = R.documentsFor(A);
  const { needed, have } = docSummary(docs);
  const outstanding = docs.filter((d) => !V.files.some((f) => f.doc_key === d.key));
  card = h('main.ff-card');
  fill(root, header(), band(`Thanks, ${V.first_name}!`, `${V.broker.name || V.brand.business_name} has your fact find and will be in touch.`),
    h('div.ff-layout.single', card), footer());
  const drawInner = () => fill(card, 
    h('div.ff-done', h('div.big', { 'aria-hidden': 'true' }, '🎉'), h('h2', 'Your fact find has been sent'),
      h('p.ff-intro', 'If anything changes, or you need to correct something, just let your broker know.')),
    needed > have ? [h('h3', `Documents still to upload (${needed - have})`), h('p.ff-hint', 'You can upload them here any time before the link expires.'), docList(outstanding.filter((d) => !d.optional))]
      : note('✓ All your documents are in. You can still add more below.', 'ok'),
    h('details', h('summary', 'Upload something else'), docList(docs.filter((d) => d.optional))));
  drawCard = drawInner; // uploads redraw this view
  drawInner();
}

function drawDocumentsOnly() {
  card = h('main.ff-card');
  fill(root, header(), band(`Hi ${V.first_name}, a few documents please`, null), h('div.ff-layout.single', card), footer());
  const drawInner = () => {
    const docs = V.requests;
    const { needed, have } = docSummary(docs);
    const done = h('button.ff-btn', { type: 'button' }, 'I\'ve uploaded everything');
    done.addEventListener('click', async () => {
      done.disabled = true;
      try {
        await call('POST', '/submit', {});
        V.status = 'submitted';
        V.locked = true;
        drawInner();
        window.scrollTo(0, 0);
      } catch (err) {
        toast(err.message, 'error');
        done.disabled = false;
      }
    });
    fill(card, 
      h('h2', V.locked ? 'Thank you!' : 'Documents we need'),
      V.locked ? note(`${V.broker.name || V.brand.business_name} has been told. You can still add documents below.`, 'ok') : (V.message || '').split(/\n{2,}/).map((p) => h('p', p)),
      note(`${have} of ${needed} uploaded. Take photos with your phone or upload PDFs.`, have >= needed ? 'ok' : ''),
      docList(docs),
      V.locked ? null : h('div.ff-nav', h('span.ff-hint', 'You can come back to this link any time.'), done));
  };
  drawCard = drawInner;
  drawInner();
}

function applyBrand(b) {
  const s = document.documentElement.style;
  s.setProperty('--brand', b.primary);
  s.setProperty('--on-brand', b.on_primary);
  s.setProperty('--brand-dark', b.dark);
  s.setProperty('--brand-link', b.link);
  s.setProperty('--brand-soft', b.soft);
}

async function start() {
  try {
    V = await call('GET');
  } catch (err) {
    fill(root, h('div.ff-layout.single', h('main.ff-card.ff-error', h('h2', 'This link isn\'t available'), h('p', err.message))));
    return;
  }
  applyBrand(V.brand);
  if (V.kind === 'full') {
    A = R.normalise(V.answers);
    const saved = R.STEPS.findIndex(([k]) => k === V.step);
    furthest = Math.max(0, saved);
    step = R.STEPS[furthest][0];
    setSave('✓ All changes saved');
  }
  draw();
}
start();
