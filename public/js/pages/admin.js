import { api, h, pageHeader, table, badge, money, pct, attempt, confirmDialog, label, formModal, state, loadLookups, field, readForm, opts, lenderLogo, toast } from '../core.js';
import { refresh } from './forms.js';
import { outlookSettingsCard } from './email.js';
import { smsSettingsCard } from './sms.js';
import { brandingCard, signatureCard } from './branding.js';
import { calendlySettingsCard } from './calendar.js';

const PARTNER_TYPES = ['real_estate', 'buyers_agent', 'solicitor', 'conveyancer', 'accountant', 'financial_planner', 'builder', 'past_client', 'other'];
const TYPE_LABELS = { real_estate: 'Real estate agent', buyers_agent: "Buyer's agent" };
const typeLabel = (t) => TYPE_LABELS[t] || label(t);

const partnerFields = [
  { name: 'name', label: 'Name', required: true },
  { name: 'company', label: 'Company' },
  { name: 'type', label: 'Type', type: 'select', options: PARTNER_TYPES.map((t) => [t, typeLabel(t)]), required: true, default: 'real_estate' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'mobile', label: 'Mobile' },
  { name: 'phone', label: 'Office phone' },
  { name: 'referral_fee_pct', label: 'Referral fee (% of upfront)', type: 'number', default: 0, required: true },
  { name: 'sms_updates', label: 'Text them when a client they referred settles (needs a mobile number)', type: 'checkbox', default: true, full: true },
  { name: 'active', label: 'Active', type: 'checkbox', default: true },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

export const lenderFields = [
  { name: 'name', label: 'Lender', required: true },
  { name: 'website', label: 'Website (for fetching a logo)', placeholder: 'westpac.com.au' },
  { name: 'upfront_pct', label: 'Upfront commission (% of loan)', type: 'number', step: 0.01, required: true, default: 0.65 },
  { name: 'trail_pct', label: 'Trail commission (% p.a.)', type: 'number', step: 0.01, required: true, default: 0.15 },
  { name: 'clawback_months', label: 'Clawback period (months)', type: 'number', step: 1, required: true, default: 24 },
  { name: 'active', label: 'Active', type: 'checkbox', default: true },
  { name: 'notes', label: 'Notes (policy, turnaround times…)', type: 'textarea', full: true },
];

const pickImage = () => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
  input.click();
});

export function logoCell(l) {
  const done = async (msg) => { toast(msg); await loadLookups(true); window.dispatchEvent(new Event('crm:refresh')); };
  const upload = async () => {
    const image = await pickImage();
    if (!image) return;
    await attempt(() => api(`/lenders/${l.id}/logo`, { method: 'POST', body: { image } }));
    done('Logo uploaded');
  };
  const fetchIt = async () => {
    await attempt(() => api(`/lenders/${l.id}/logo/fetch`, { method: 'POST', body: {} }));
    done('Logo fetched from website');
  };
  const remove = async () => {
    await attempt(() => api(`/lenders/${l.id}/logo`, { method: 'DELETE' }));
    done('Logo removed');
  };
  return h('div.logo-cell',
    l.logo_asset_id ? lenderLogo(l.logo_asset_id, l.name, 'md') : h('span.logo-empty', 'No logo'),
    h('div.row-actions.small',
      h('button.link.small', { type: 'button', onclick: upload }, 'Upload'),
      l.website ? h('button.link.small', { type: 'button', onclick: fetchIt }, 'Fetch') : null,
      l.logo_asset_id ? h('button.link.small', { type: 'button', onclick: remove }, 'Remove') : null));
}

function crudPage({ title, singular, path, fields, columns, intro, intro2 }) {
  return async () => {
    const { rows } = await api(path);
    const edit = (row) => formModal(row ? `Edit ${row.name}` : `New ${singular || title.replace(/s$/, '').toLowerCase()}`, fields, row || {}, async (v) => {
      await attempt(() => api(row ? `${path}/${row.id}` : path, { method: row ? 'PATCH' : 'POST', body: v }), 'Saved');
      await loadLookups(true);
      refresh();
    });
    const remove = async (row) => {
      if (!(await confirmDialog(`Delete ${row.name}? Existing deals keep their history but lose the link.`))) return;
      await attempt(() => api(`${path}/${row.id}`, { method: 'DELETE' }), 'Deleted');
      await loadLookups(true);
      refresh();
    };
    return h('div',
      pageHeader(title, h('button', { type: 'button', onclick: () => edit() }, `+ Add`)),
      intro ? h('p.muted', intro) : null,
      intro2 ? h('p.muted', intro2) : null,
      table([...columns, { label: '', value: (r) => h('button.link.small', { type: 'button', onclick: () => remove(r) }, 'Delete') }], rows, { onRow: edit }));
  };
}

export const partnersPage = crudPage({
  title: 'Partners & professionals',
  singular: 'contact',
  path: '/partners',
  fields: partnerFields,
  intro: 'Real estate agents, solicitors, conveyancers, buyer\'s agents, accountants and others you work with. Pick them on a deal as the agent or solicitor, or as the referral partner who sent you the client.',
  intro2: 'Referral fees are deducted automatically from upfront commission when a referred deal settles, and the partner gets a thank-you text (see the "Settled: thank the referral partner" automation).',
  columns: [
    { label: 'Name', value: (p) => h('div', h('strong', p.name), p.active ? null : badge('inactive')) },
    { label: 'Company', value: (p) => p.company || '—' },
    { label: 'Type', value: (p) => typeLabel(p.type) },
    { label: 'Contact', value: (p) => [p.email, p.mobile || p.phone].filter(Boolean).join(' · ') || '—' },
    { label: 'On deals', value: (p) => String(p.deals_involved), class: 'num' },
    { label: 'Referrals', value: (p) => String(p.referrals), class: 'num' },
    { label: 'Settlement texts', value: (p) => (p.sms_updates ? (p.mobile || p.phone ? `On${p.texts_sent ? ` · ${p.texts_sent} sent` : ''}` : h('span.text-warn', 'On – no mobile')) : h('span.muted', 'Off')) },
    { label: 'Settled', value: (p) => `${p.settled_count} · ${money(p.settled_volume)}`, class: 'num' },
    { label: 'Fee', value: (p) => pct(p.referral_fee_pct), class: 'num' },
  ],
});

export async function settingsPage() {
  const isAdmin = state.user.role === 'admin';
  const settings = await api('/settings');
  const { rows: users } = await api('/users');

  const bizFields = [
    { name: 'business_name', label: 'Business name' },
    { name: 'acl_number', label: 'ACL / credit rep number' },
    { name: 'business_phone', label: 'Phone' },
    { name: 'business_email', label: 'Email (also the "from" address)', type: 'email' },
    { name: 'business_website', label: 'Website' },
    { name: 'monthly_settlement_target', label: 'Monthly settlement target ($)', type: 'number' },
    { name: 'app_url', label: 'CRM web address (for links in reminder emails)', placeholder: `${location.origin}` },
  ];
  const bizForm = h('form.grid-form', bizFields.map((f) => field(f, settings[f.name])), isAdmin ? h('div.actions.full', h('button', { type: 'submit' }, 'Save')) : null);
  if (!isAdmin) for (const el of bizForm.elements) el.disabled = true;
  bizForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await attempt(() => api('/settings', { method: 'PUT', body: readForm(bizForm, bizFields) }), 'Settings saved');
  });

  const userFields = (isNew) => [
    { name: 'name', label: 'Name', required: true },
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'phone', label: 'Phone' },
    { name: 'role', label: 'Role', type: 'select', required: true, default: 'broker', options: [['admin', 'Admin'], ['broker', 'Broker'], ['assistant', 'Assistant / processor']] },
    { name: 'password', label: isNew ? 'Password (8+ chars)' : 'New password (leave blank to keep)', type: 'password', required: isNew },
    ...(isNew ? [] : [{ name: 'active', label: 'Active', type: 'checkbox' }]),
  ];
  const editUser = (u) => formModal(u ? `Edit ${u.name}` : 'Add user', userFields(!u), u || {}, async (v) => {
    if (!v.password) delete v.password;
    await attempt(() => api(u ? `/users/${u.id}` : '/users', { method: u ? 'PATCH' : 'POST', body: v }), 'User saved');
    await loadLookups(true);
    refresh();
  });

  const pwFields = [
    { name: 'current_password', label: 'Current password', type: 'password', required: true },
    { name: 'new_password', label: 'New password (8+ chars)', type: 'password', required: true },
  ];
  const pwForm = h('form.grid-form', pwFields.map((f) => field(f)), h('div.actions.full', h('button', { type: 'submit' }, 'Change password')));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await attempt(() => api('/auth/change-password', { method: 'POST', body: readForm(pwForm, pwFields) }), 'Password changed');
    pwForm.reset();
  });

  return h('div',
    pageHeader('Settings'),
    await brandingCard(),
    await signatureCard(),
    await outlookSettingsCard(),
    await smsSettingsCard(),
    await calendlySettingsCard(),
    h('section.card', h('h2', 'Business'), bizForm),
    h('section.card',
      h('div.card-head', h('h2', 'Team'), isAdmin ? h('button.small', { type: 'button', onclick: () => editUser() }, '+ Add user') : null),
      table([
        { label: 'Name', value: (u) => u.name },
        { label: 'Email', value: (u) => u.email },
        { label: 'Role', value: (u) => label(u.role) },
        { label: 'Status', value: (u) => badge(u.active ? 'active' : 'inactive', u.active ? 'ok' : '') },
      ], users, { onRow: isAdmin ? editUser : undefined })),
    h('section.card', h('h2', 'My password'), pwForm));
}
