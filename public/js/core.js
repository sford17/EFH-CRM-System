// Shared helpers: API client, DOM builder, formatting, forms, modals, toasts.

export const state = { user: null, meta: null, users: [], lenders: [], partners: [] };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/auth')) {
    location.hash = '#/login';
    throw new Error('Please sign in');
  }
  if (res.status === 403 && data?.reason === 'mfa_setup_required') window.dispatchEvent(new Event('crm:mfa-setup'));
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// h('div.card#main', { onclick }, child, 'text', [more]) — children are text-safe.
export function h(tag, attrs, ...children) {
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
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (el) => { el.replaceChildren(); return el; };

// ---- Formatting ------------------------------------------------------------
const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const AUD2 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2 });
export const money = (n) => (n === null || n === undefined || n === '' ? '—' : AUD.format(n));
export const money2 = (n) => (n === null || n === undefined || n === '' ? '—' : AUD2.format(n));
export const pct = (n) => (n === null || n === undefined || n === '' ? '—' : `${Number(n).toFixed(2)}%`);
export const compact = (n) => new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);

export function date(d) {
  if (!d) return '—';
  const dt = new Date(String(d).length === 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function dateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function relDays(d) {
  if (!d) return '';
  const diff = Math.round((new Date(`${d}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}
export const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');
const SPECIAL_LABELS = { payg: 'PAYG', pi: 'P&I', io: 'Interest only', lvr: 'LVR' };
export const label = (s) => SPECIAL_LABELS[s] || String(s ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const stageLabel = (key) => state.meta?.stages.find((s) => s.key === key)?.label || label(key);

export const badge = (text, kind = '') => h(`span.badge${kind ? `.${kind}` : ''}`, label(text));

// ---- Feedback --------------------------------------------------------------
export function toast(message, kind = 'ok') {
  const el = h(`div.toast.${kind}`, { role: 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

export async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, 'error');
    err.toasted = true;
    throw err;
  }
}

// ---- Modal -----------------------------------------------------------------
export function modal(title, content, { wide = false } = {}) {
  const dialog = h(`dialog.modal${wide ? '.wide' : ''}`,
    h('header', h('h2', title), h('button.icon', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    h('div.modal-body', content));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    let result = false;
    const d = modal('Please confirm', [
      h('p', message),
      h('div.actions',
        h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'),
        h('button.danger', { type: 'button', onclick: () => { result = true; d.close(); } }, 'Confirm')),
    ]);
    d.addEventListener('close', () => resolve(result));
  });
}

// ---- Forms -----------------------------------------------------------------
// field: { name, label, type: text|number|date|email|select|textarea|checkbox, options: [[value,label]], required, step, full }
export function field(f, value) {
  const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
  let input;
  if (f.type === 'select') {
    const opts = typeof f.options === 'function' ? f.options() : f.options;
    input = h('select', { id, name: f.name, required: f.required },
      f.required ? null : h('option', { value: '' }, '—'),
      opts.map(([v, l]) => h('option', { value: v, selected: String(value ?? f.default ?? '') === String(v) }, l)));
  } else if (f.type === 'textarea') {
    input = h('textarea', { id, name: f.name, rows: f.rows || 4, required: f.required, placeholder: f.placeholder }, value ?? '');
  } else if (f.type === 'checkbox') {
    input = h('input', { id, name: f.name, type: 'checkbox', checked: value === undefined ? !!f.default : !!Number(value) });
    return h('label.field.check', input, f.label);
  } else {
    input = h('input', {
      id, name: f.name, type: f.type || 'text', required: f.required, step: f.step || (f.type === 'number' ? 'any' : undefined),
      value: value ?? f.default ?? '', placeholder: f.placeholder,
    });
  }
  return h(`div.field${f.full ? '.full' : ''}`, h('label', { for: id }, f.label, f.required ? ' *' : ''), input);
}

export function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'checkbox') out[f.name] = el.checked ? 1 : 0;
    else if (f.type === 'number') out[f.name] = el.value === '' ? null : Number(el.value);
    else out[f.name] = el.value === '' ? null : el.value;
  }
  return out;
}

// Opens a modal form; resolves via onSubmit(values) which may throw to keep it open.
// `extra` is an element added below the fields (read it in onSubmit).
export function formModal(title, fields, values = {}, onSubmit, { submitLabel = 'Save', wide = true, extra = null, before = null } = {}) {
  const form = h('form.grid-form',
    before,
    fields.map((f) => field(f, values[f.name])),
    extra,
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'submit' }, submitLabel)));
  const dialog = modal(title, form, { wide });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSubmit(readForm(form, fields));
      dialog.close();
    } catch (err) {
      if (!err.toasted) toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  return dialog;
}

// ---- Tables ----------------------------------------------------------------
// columns: [{ label, value: row => node|string, class }]
export function table(columns, rows, { onRow, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return h('p.empty', empty);
  return h('div.table-wrap', h('table',
    h('thead', h('tr', columns.map((c) => h('th', { class: c.class }, c.label)))),
    h('tbody', rows.map((r) => h('tr', { class: onRow ? 'clickable' : undefined, onclick: onRow ? (e) => { if (!e.target.closest('button,a,input,select')) onRow(r); } : undefined },
      columns.map((c) => h('td', { class: c.class }, c.value(r))))))));
}

// ---- Lookups ---------------------------------------------------------------
export async function loadLookups(force = false) {
  if (state.meta && !force) return;
  const [meta, users, lenders, partners] = await Promise.all([api('/meta'), api('/users'), api('/lenders'), api('/partners')]);
  state.meta = meta;
  state.users = users.rows;
  state.lenders = lenders.rows;
  state.partners = partners.rows;
}

export const userOptions = () => state.users.filter((u) => u.active).map((u) => [u.id, u.name]);
export const lenderOptions = () => state.lenders.filter((l) => l.active).map((l) => [l.id, l.name]);
export const partnerOptions = () => state.partners.filter((p) => p.active).map((p) => [p.id, `${p.name}${p.company ? ` (${p.company})` : ''}`]);
export const stageOptions = () => state.meta.stages.map((s) => [s.key, s.label]);
export const opts = (list) => list.map((v) => [v, label(v)]);

export const pageHeader = (title, ...actions) => h('div.page-header', h('h1', title), h('div.actions', actions));
export const link = (href, text) => h('a', { href }, text);

// Lender logo (if one has been added on the Lenders page), sized to fit.
export function lenderLogo(assetId, name, size = 'sm') {
  if (!assetId) return null;
  return h(`img.lender-logo.${size}`, { src: `/assets/${assetId}`, alt: name ? `${name} logo` : '', loading: 'lazy' });
}

// Lender logo + name, or just the name.
export const lenderTag = (assetId, name, size = 'sm') => (name ? h('span.lender-tag', lenderLogo(assetId, name, size), h('span', name)) : '—');
