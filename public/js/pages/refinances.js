// Internal refinance register: the editable entry (existing loan beside the
// new loan) and the card on a client's Mortgage tracker tab.
import {
  api, h, attempt, modal, confirmDialog, field, readForm, money, date, pct, badge, state, fullName, toast, lenderTag, userOptions,
} from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
export const STATUS_KIND = { needs_review: 'warn', in_progress: 'info', completed: 'ok' };
const STATUS_OPTIONS = [['completed', 'Completed'], ['in_progress', 'In progress'], ['needs_review', 'Needs review']];
const LOAN_TYPE_OPTIONS = [['home_loan', 'Home loan'], ['investment_loan', 'Investment loan'], ['line_of_credit', 'Line of credit'], ['construction', 'Construction'],
  ['bridging', 'Bridging'], ['commercial', 'Commercial'], ['business_loan', 'Business loan'], ['smsf', 'SMSF loan'], ['personal', 'Personal'], ['car', 'Car'], ['other', 'Other']];
const RATE_OPTIONS = [['variable', 'Variable'], ['fixed', 'Fixed'], ['split', 'Split']];
const REASONS = ['Better interest rate', 'Fixed rate expiry', 'Cash out / equity release', 'Debt consolidation', 'Lender service', 'Loan structure change',
  'Construction', 'Separation / change of borrowers', 'Retention offer declined'];

// Both sides share these fields; the existing loan adds its balance and pay-out date.
const sideFields = (side) => [
  { name: `${side}_borrowers`, label: 'Borrower(s)', full: true },
  { name: `${side}_account_number`, label: side === 'new' ? 'Account / application no.' : 'Account number' },
  { name: `${side}_product`, label: 'Product' },
  { name: `${side}_loan_type`, label: 'Loan type', type: 'select', options: LOAN_TYPE_OPTIONS },
  { name: `${side}_rate_type`, label: 'Rate type', type: 'select', options: RATE_OPTIONS },
  { name: `${side}_loan_amount`, label: 'Loan amount ($)', type: 'number' },
  { name: `${side}_interest_rate`, label: 'Interest rate (%)', type: 'number', step: '0.01' },
  ...(side === 'old' ? [{ name: 'old_balance', label: 'Balance when refinanced ($)', type: 'number' }] : []),
  { name: `${side}_settlement_date`, label: side === 'old' ? 'Original settlement date' : 'Settlement date', type: 'date' },
  ...(side === 'old' ? [{ name: 'old_discharge_date', label: 'Discharged / paid out', type: 'date' }] : []),
  { name: `${side}_broker_id`, label: 'Broker', type: 'select', options: userOptions },
];
const OTHER_FIELDS = [
  { name: 'clawback_amount', label: 'Clawback on the old loan ($)', type: 'number' },
  { name: 'cashback', label: 'Lender cashback / incentive ($)', type: 'number' },
  { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, full: true },
];
const TOP_FIELDS = [
  { name: 'client_name', label: 'Client name (as recorded)', required: true },
  { name: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, required: true, default: 'completed' },
];
const ALL_FIELDS = [...TOP_FIELDS, ...sideFields('old'), ...sideFields('new'), ...OTHER_FIELDS];

// Lender: a list of the lenders on file, or "Other" with a typed name (for
// lenders no longer used).
function lenderPicker(side, values) {
  const lenders = state.lenders;
  const id = values[`${side}_lender_id`];
  const known = id && lenders.some((l) => l.id === id);
  const select = h('select', { name: `${side}_lender_id`, 'aria-label': side === 'old' ? 'Existing lender' : 'New lender' },
    h('option', { value: '' }, 'Choose…'),
    lenders.filter((l) => l.active || l.id === id).map((l) => h('option', { value: l.id, selected: l.id === id }, l.name)),
    h('option', { value: 'other', selected: !known && Boolean(values[`${side}_lender_name`]) }, 'Other (type the name)'));
  const other = h('input', { type: 'text', name: `${side}_lender_other`, placeholder: 'Lender name', 'aria-label': 'Lender name', value: known ? '' : values[`${side}_lender_name`] || '' });
  const sync = () => { other.hidden = select.value !== 'other'; };
  select.addEventListener('change', sync);
  sync();
  return {
    el: h('div.field.full', h('label', 'Lender'), h('div.lender-pick', select, other)),
    set(lenderId, name) {
      if (lenderId && lenders.some((l) => l.id === lenderId)) select.value = String(lenderId);
      else if (name) { select.value = 'other'; other.value = name; } else select.value = '';
      sync();
    },
    read() {
      if (select.value === 'other') return { lender_id: null, lender_name: other.value.trim() || null };
      if (!select.value) return { lender_id: null, lender_name: null };
      const l = lenders.find((x) => x.id === Number(select.value));
      return { lender_id: Number(select.value), lender_name: l?.name || null };
    },
  };
}

// Client search box: type a name, pick from the list.
function clientSearch(onPick) {
  const listId = `ir_clients_${Math.random().toString(36).slice(2, 7)}`;
  const found = new Map();
  const nameOf = (c) => `${fullName(c)}${c.email ? ` (${c.email})` : ''}`;
  const input = h('input', { type: 'search', list: listId, placeholder: 'Start typing a client\'s name…', 'aria-label': 'Find client' });
  const list = h('datalist', { id: listId });
  let n = 0;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (found.has(q)) { onPick(found.get(q)); return; }
    if (q.length < 2) return;
    const mine = ++n;
    setTimeout(async () => {
      if (mine !== n) return;
      const { rows } = await api(`/contacts?limit=20&q=${encodeURIComponent(q)}`);
      if (mine !== n) return;
      for (const c of rows) found.set(nameOf(c), c);
      list.replaceChildren(...rows.map((c) => h('option', { value: nameOf(c) })));
    }, 200);
  });
  return h('span', input, list);
}

// Opens the editable entry. `entry` is an existing record, or null with
// `contact` for a new one about that client.
export async function refinanceDialog(entry = null, { contact = null } = {}) {
  const values = entry ? { ...entry } : { status: 'completed', contact_id: contact?.id ?? null };
  let links = {
    contact_id: values.contact_id ?? null, old_loan_id: values.old_loan_id ?? null,
    new_loan_id: values.new_loan_id ?? null, new_deal_id: values.new_deal_id ?? null,
  };
  const fieldsBy = (list) => list.map((f) => field(f, values[f.name]));
  const oldLender = lenderPicker('old', values);
  const newLender = lenderPicker('new', values);
  const reasonId = `ir_reasons_${Math.random().toString(36).slice(2, 7)}`;
  const reason = h('div.field.full', h('label', { for: `${reasonId}_in` }, 'Reason for the refinance'),
    h('input', { id: `${reasonId}_in`, name: 'reason', list: reasonId, value: values.reason || '', placeholder: 'e.g. Better interest rate' }),
    h('datalist', { id: reasonId }, REASONS.map((r) => h('option', { value: r }))));

  // "Fill from" pickers, loaded from the client's tracker loans and deals.
  const oldPick = h('select', { 'aria-label': 'Fill the existing loan from' });
  const newPick = h('select', { 'aria-label': 'Fill the new loan from' });
  const prefill = h('div.ir-prefill', { hidden: true },
    h('div.field', h('label', 'Fill the existing loan from'), oldPick),
    h('div.field', h('label', 'Fill the new loan from'), newPick));
  const clientLine = h('p.ir-client');
  const markOld = h('label.field.check.full', { hidden: true }, h('input', { type: 'checkbox', name: 'mark_old_refinanced', checked: true }),
    'Mark the existing loan as "Refinanced" in the client\'s Mortgage tracker');
  const syncMark = () => {
    markOld.hidden = !links.old_loan_id || (entry && entry.old_loan_status && entry.old_loan_status !== 'active');
  };

  const form = h('form.grid-form.ir-form');
  const put = (data) => {
    for (const [k, v] of Object.entries(data)) {
      if (k.endsWith('_lender_id') || k.endsWith('_lender_name')) continue;
      if (Object.hasOwn(links, k)) { links[k] = v ?? null; continue; }
      const el = form.elements[k];
      if (el && v !== undefined) el.value = v ?? '';
    }
    for (const [side, picker] of [['old', oldLender], ['new', newLender]]) {
      if (Object.hasOwn(data, `${side}_lender_id`) || Object.hasOwn(data, `${side}_lender_name`)) picker.set(data[`${side}_lender_id`], data[`${side}_lender_name`]);
    }
    syncMark();
  };

  let options = null;
  async function loadClient(c, { fill }) {
    links.contact_id = c.id;
    clientLine.replaceChildren('Linked to ', h('a', { href: `#/contacts/${c.id}?tab=tracker` }, fullName(c)));
    options = await api(`/refinances/options/${c.id}`);
    if (fill) {
      if (!form.elements.client_name.value) form.elements.client_name.value = options.client_name;
      for (const side of ['old', 'new']) if (!form.elements[`${side}_borrowers`].value) form.elements[`${side}_borrowers`].value = options.borrowers;
    }
    const recordedDeals = new Set(options.recorded.filter((r) => r.id !== entry?.id).map((r) => r.new_deal_id));
    oldPick.replaceChildren(h('option', { value: '' }, options.loans.length ? 'Choose a tracker loan…' : 'No loans in the tracker'),
      ...options.loans.map((n, i) => h('option', { value: i, selected: n.id === links.old_loan_id }, n.label)));
    newPick.replaceChildren(h('option', { value: '' }, options.deals.length || options.loans.length ? 'Choose a deal or loan…' : 'No deals or loans yet'),
      options.deals.length ? h('optgroup', { label: 'Deals' }, ...options.deals.map((d, i) => h('option', { value: `d${i}`, selected: d.id === links.new_deal_id, disabled: recordedDeals.has(d.id) }, `${d.label}${recordedDeals.has(d.id) ? ' – already recorded' : ''}`))) : null,
      options.loans.length ? h('optgroup', { label: 'Tracker loans' }, ...options.loans.map((n, i) => h('option', { value: `l${i}`, selected: !links.new_deal_id && n.id === links.new_loan_id }, n.label))) : null);
    prefill.hidden = false;
    syncMark();
  }
  oldPick.addEventListener('change', () => { if (oldPick.value !== '') put(options.loans[Number(oldPick.value)].old); });
  newPick.addEventListener('change', () => {
    const v = newPick.value;
    if (!v) return;
    put(v[0] === 'd' ? options.deals[Number(v.slice(1))].new : { ...options.loans[Number(v.slice(1))].new, new_deal_id: null });
  });

  const contactBox = h('div.field.full.ir-find',
    h('label', 'Client'), clientLine,
    clientSearch(async (c) => {
      // A different client: start their links afresh, keep what's been typed.
      links = { contact_id: c.id, old_loan_id: null, new_loan_id: null, new_deal_id: null };
      form.elements.client_name.value = '';
      await loadClient(c, { fill: true });
    }));
  if (!links.contact_id) clientLine.textContent = 'Not linked to a client yet. Find them below, or just type the name.';

  const del = entry ? h('button.danger.secondary', { type: 'button' }, 'Delete') : null;
  const deal = entry?.new_deal_id ? h('a.button.secondary', { href: `#/deals/${entry.new_deal_id}` }, 'Open deal') : null;
  form.append(
    contactBox,
    ...fieldsBy(TOP_FIELDS),
    reason,
    prefill,
    h('div.ir-sides.full',
      h('fieldset.ir-side.old', h('legend', 'Existing loan (refinanced away)'), h('div.grid-form', oldLender.el, ...fieldsBy(sideFields('old')))),
      h('div.ir-arrow', { 'aria-hidden': 'true' }, '→'),
      h('fieldset.ir-side.new', h('legend', 'New loan'), h('div.grid-form', newLender.el, ...fieldsBy(sideFields('new'))))),
    ...fieldsBy(OTHER_FIELDS),
    markOld,
    entry?.source === 'auto' ? h('p.muted.small.full', 'Recorded automatically when the refinance deal settled. Check the details and set the status to Completed.') : null,
    h('div.actions.full', del, deal, h('span.spacer'),
      h('button.secondary', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'submit' }, entry ? 'Save' : 'Add to register')),
  );
  const dialog = modal(entry ? `Internal refinance – ${entry.client_name}` : 'Record an internal refinance', form, { wide: true });
  dialog.classList.add('ir-dialog');

  if (links.contact_id) {
    const c = contact || await api(`/contacts/${links.contact_id}`).catch(() => null);
    if (c) await loadClient(c.contact || c, { fill: !entry });
    else links.contact_id = null;
  }

  del?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete this internal refinance for ${entry.client_name}? This can't be undone.`))) return;
    await attempt(() => api(`/refinances/${entry.id}`, { method: 'DELETE' }), 'Deleted');
    dialog.close();
    refresh();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const body = { ...readForm(form, ALL_FIELDS), ...links, reason: form.elements.reason.value.trim() || null };
    for (const [side, picker] of [['old', oldLender], ['new', newLender]]) {
      const l = picker.read();
      body[`${side}_lender_id`] = l.lender_id;
      body[`${side}_lender_name`] = l.lender_name;
    }
    body.mark_old_refinanced = !markOld.hidden && form.elements.mark_old_refinanced.checked;
    btn.disabled = true;
    try {
      await api(entry ? `/refinances/${entry.id}` : '/refinances', { method: entry ? 'PUT' : 'POST', body });
      toast(entry ? 'Saved' : 'Added to the internal refinance register');
      dialog.close();
      refresh();
    } catch (err) {
      if (!err.toasted) toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  return dialog;
}

// One side of an entry, for tables: lender, amount and dates.
export function sideCell(r, side) {
  const amount = side === 'old' ? r.old_balance ?? r.old_loan_amount : r.new_loan_amount;
  const dates = side === 'old'
    ? [r.old_settlement_date ? `from ${date(r.old_settlement_date)}` : null, r.old_discharge_date ? `to ${date(r.old_discharge_date)}` : null]
    : [r.new_settlement_date ? `settled ${date(r.new_settlement_date)}` : null];
  return h('div.ir-cell',
    lenderTag(r[`${side}_lender_logo_id`], r[`${side}_lender_name`]),
    h('div.small', [money(amount), r[`${side}_interest_rate`] ? pct(r[`${side}_interest_rate`]) : null, r[`${side}_account_number`] ? `#${r[`${side}_account_number`]}` : null].filter(Boolean).join(' · ')),
    dates.some(Boolean) ? h('div.muted.small', dates.filter(Boolean).join(' ')) : null);
}

export function heldCell(r) {
  return h('div',
    r.months_held === null ? '—' : `${r.months_held} month${r.months_held === 1 ? '' : 's'}`,
    r.within_clawback ? h('div', badge(`clawback until ${date(r.clawback_until)}`, 'danger')) : null);
}

// Card on a client's Mortgage tracker tab.
export async function refinancesCard(contact) {
  const { rows } = await api(`/refinances?period=all&contact_id=${contact.id}`);
  return h('section.card',
    h('div.card-head', h('h2', `Internal refinances${rows.length ? ` (${rows.length})` : ''}`),
      h('button.small', { type: 'button', onclick: () => refinanceDialog(null, { contact }) }, '+ Internal refinance')),
    rows.length ? h('div.table-wrap', h('table',
      h('thead', h('tr', ['Date', 'Existing loan', '', 'New loan', 'Held', 'Status'].map((t) => h('th', t)))),
      h('tbody', rows.map((r) => h('tr.clickable', { onclick: () => refinanceDialog(r, { contact }) },
        h('td', date(r.switch_date)), h('td', sideCell(r, 'old')), h('td.ir-arrow', '→'), h('td', sideCell(r, 'new')), h('td', heldCell(r)),
        h('td', badge(r.status_label, STATUS_KIND[r.status]))))))) : h('p.empty', 'When you move this client from one of your loans to a new lender, record it here (refinance deals that settle are added automatically).'));
}
