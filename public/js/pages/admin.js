import { api, h, pageHeader, table, badge, money, pct, attempt, confirmDialog, label, formModal, state, loadLookups, field, readForm, opts } from '../core.js';
import { refresh } from './forms.js';
import { outlookSettingsCard } from './email.js';
import { smsSettingsCard } from './sms.js';

const PARTNER_TYPES = ['real_estate', 'accountant', 'financial_planner', 'solicitor', 'builder', 'past_client', 'other'];

const partnerFields = [
  { name: 'name', label: 'Name', required: true },
  { name: 'company', label: 'Company' },
  { name: 'type', label: 'Type', type: 'select', options: opts(PARTNER_TYPES), required: true, default: 'real_estate' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'referral_fee_pct', label: 'Referral fee (% of upfront)', type: 'number', default: 0, required: true },
  { name: 'active', label: 'Active', type: 'checkbox', default: true },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

const lenderFields = [
  { name: 'name', label: 'Lender', required: true },
  { name: 'upfront_pct', label: 'Upfront commission (% of loan)', type: 'number', step: 0.01, required: true, default: 0.65 },
  { name: 'trail_pct', label: 'Trail commission (% p.a.)', type: 'number', step: 0.01, required: true, default: 0.15 },
  { name: 'clawback_months', label: 'Clawback period (months)', type: 'number', step: 1, required: true, default: 24 },
  { name: 'bdm_name', label: 'BDM name' },
  { name: 'bdm_email', label: 'BDM email', type: 'email' },
  { name: 'bdm_phone', label: 'BDM phone' },
  { name: 'active', label: 'Active', type: 'checkbox', default: true },
  { name: 'notes', label: 'Notes (policy, turnaround times…)', type: 'textarea', full: true },
];

function crudPage({ title, path, fields, columns, intro }) {
  return async () => {
    const { rows } = await api(path);
    const edit = (row) => formModal(row ? `Edit ${row.name}` : `New ${title.replace(/s$/, '').toLowerCase()}`, fields, row || {}, async (v) => {
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
      table([...columns, { label: '', value: (r) => h('button.link.small', { type: 'button', onclick: () => remove(r) }, 'Delete') }], rows, { onRow: edit }));
  };
}

export const partnersPage = crudPage({
  title: 'Referral partners',
  path: '/partners',
  fields: partnerFields,
  intro: 'Track who sends you business. Referral fees are deducted automatically from upfront commission when a referred deal settles.',
  columns: [
    { label: 'Name', value: (p) => h('div', h('strong', p.name), p.active ? null : badge('inactive')) },
    { label: 'Company', value: (p) => p.company || '—' },
    { label: 'Type', value: (p) => label(p.type) },
    { label: 'Contact', value: (p) => [p.email, p.phone].filter(Boolean).join(' · ') || '—' },
    { label: 'Referrals', value: (p) => String(p.referrals), class: 'num' },
    { label: 'Settled', value: (p) => `${p.settled_count} · ${money(p.settled_volume)}`, class: 'num' },
    { label: 'Fee', value: (p) => pct(p.referral_fee_pct), class: 'num' },
  ],
});

export const lendersPage = crudPage({
  title: 'Lenders',
  path: '/lenders',
  fields: lenderFields,
  intro: 'Commission rates drive the expected upfront and trail entries created at settlement. Defaults are indicative – update them to match your aggregator schedule.',
  columns: [
    { label: 'Lender', value: (l) => h('div', h('strong', l.name), l.active ? null : badge('inactive')) },
    { label: 'Upfront', value: (l) => pct(l.upfront_pct), class: 'num' },
    { label: 'Trail', value: (l) => pct(l.trail_pct), class: 'num' },
    { label: 'Clawback', value: (l) => `${l.clawback_months} mths`, class: 'num' },
    { label: 'BDM', value: (l) => [l.bdm_name, l.bdm_phone].filter(Boolean).join(' · ') || '—' },
    { label: 'Settled', value: (l) => `${l.settled_count} · ${money(l.settled_volume)}`, class: 'num' },
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
    await outlookSettingsCard(),
    await smsSettingsCard(),
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
