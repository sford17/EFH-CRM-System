// Field definitions and shared widgets used across pages.
import {
  api, h, opts, userOptions, lenderOptions, partnerOptions, stageOptions, formModal, attempt, toast, state,
  date, dateTime, link, label, modal, field, readForm, fullName, loadLookups,
} from '../core.js';
import { addresseePicker, householdOf } from './household.js';
import { partiesFieldset } from './parties.js';
import { bodyPreview } from './graphics.js';
import { borrowersFieldset, TRUST_TYPES, ENTITY_LABELS } from './borrowers.js';

export const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
export const CONTACT_STATUSES = ['lead', 'prospect', 'client', 'past_client', 'lost'];
export const LEAD_SOURCES = ['website', 'referral', 'walk_in', 'social', 'repeat', 'phone', 'other'];
export const LOAN_PURPOSES = ['purchase', 'first_home', 'refinance', 'investment', 'construction', 'top_up', 'commercial', 'other'];

// A company or trust: one name, ABN/ACN and business details instead of personal ones.
const entityFields = (type) => [
  { name: 'first_name', label: type === 'trust' ? 'Trust name (e.g. Jones Family Trust)' : 'Company name (e.g. Jones Holdings Pty Ltd)', required: true, full: true },
  { name: 'abn', label: 'ABN' },
  { name: 'acn', label: type === 'trust' ? 'Corporate trustee ACN (if any)' : 'ACN' },
  ...(type === 'trust' ? [{ name: 'trust_type', label: 'Kind of trust', type: 'select', options: TRUST_TYPES }] : []),
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'phone', label: 'Phone' },
  { name: 'status', label: 'Status', type: 'select', options: opts(CONTACT_STATUSES), required: true, default: 'lead' },
  { name: 'lead_source', label: 'Lead source', type: 'select', options: opts(LEAD_SOURCES) },
  { name: 'referral_partner_id', label: 'Referred by', type: 'select', options: partnerOptions },
  { name: 'owner_id', label: 'Owner', type: 'select', options: userOptions, default: state.user?.id },
  { name: 'address', label: 'Registered / business address', full: true },
  { name: 'suburb', label: 'Suburb' },
  { name: 'state', label: 'State', type: 'select', options: STATES.map((s) => [s, s]) },
  { name: 'postcode', label: 'Postcode' },
  { name: 'tags', label: 'Tags (comma separated)', full: true },
  { name: 'background', label: 'Background notes', type: 'textarea', full: true },
];

export const contactFields = (type = 'person') => (type !== 'person' ? entityFields(type) : [
  { name: 'first_name', label: 'First name', required: true },
  { name: 'last_name', label: 'Last name' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'mobile', label: 'Mobile' },
  { name: 'phone', label: 'Other phone' },
  { name: 'dob', label: 'Date of birth', type: 'date' },
  { name: 'status', label: 'Status', type: 'select', options: opts(CONTACT_STATUSES), required: true, default: 'lead' },
  { name: 'lead_source', label: 'Lead source', type: 'select', options: opts(LEAD_SOURCES) },
  { name: 'referral_partner_id', label: 'Referred by', type: 'select', options: partnerOptions },
  { name: 'owner_id', label: 'Owner', type: 'select', options: userOptions, default: state.user?.id },
  { name: 'address', label: 'Street address', full: true },
  { name: 'suburb', label: 'Suburb' },
  { name: 'state', label: 'State', type: 'select', options: STATES.map((s) => [s, s]) },
  { name: 'postcode', label: 'Postcode' },
  { name: 'employment_type', label: 'Employment', type: 'select', options: opts(['payg', 'self_employed', 'contractor', 'casual', 'retired', 'other']) },
  { name: 'employer', label: 'Employer / business' },
  { name: 'annual_income', label: 'Annual income ($)', type: 'number' },
  { name: 'marital_status', label: 'Marital status', type: 'select', options: opts(['single', 'married', 'de_facto', 'separated', 'divorced', 'widowed']) },
  { name: 'dependants', label: 'Dependants', type: 'number', step: 1 },
  { name: 'next_review_date', label: 'Next review date', type: 'date' },
  { name: 'tags', label: 'Tags (comma separated)', full: true },
  { name: 'marketing_opt_in', label: 'Happy to receive marketing emails & texts', type: 'checkbox', default: true },
  { name: 'sms_opt_out', label: 'Opted out of all SMS (replied STOP)', type: 'checkbox', default: false },
  { name: 'background', label: 'Background notes', type: 'textarea', full: true },
]);

// Person / Company / Trust buttons at the top of a contact form.
export function entityTypeSwitch(type, onChange) {
  return h('div.segmented.full', { role: 'radiogroup', 'aria-label': 'Type of contact' },
    Object.entries(ENTITY_LABELS).map(([key, text]) => h('button.secondary', { type: 'button', role: 'radio', 'aria-checked': String(key === type), onclick: () => key !== type && onChange(key) }, text)));
}

export const dealFields = () => [
  { name: 'title', label: 'Deal name (auto if blank)', full: true },
  { name: 'loan_purpose', label: 'Loan purpose', type: 'select', options: opts(LOAN_PURPOSES), required: true, default: 'purchase' },
  { name: 'priority', label: 'Priority', type: 'select', options: opts(['low', 'normal', 'high']), required: true, default: 'normal' },
  { name: 'property_address', label: 'Security property address', full: true },
  { name: 'property_value', label: 'Property value ($)', type: 'number' },
  { name: 'loan_amount', label: 'Loan amount ($)', type: 'number' },
  { name: 'deposit', label: 'Deposit / equity ($)', type: 'number' },
  { name: 'lender_id', label: 'Lender', type: 'select', options: lenderOptions },
  { name: 'product_name', label: 'Product' },
  { name: 'interest_rate', label: 'Interest rate (%)', type: 'number', step: 0.01 },
  { name: 'rate_type', label: 'Rate type', type: 'select', options: opts(['variable', 'fixed', 'split']), default: 'variable' },
  { name: 'fixed_expiry_date', label: 'Fixed rate expiry', type: 'date' },
  { name: 'loan_term_years', label: 'Term (years)', type: 'number', step: 1, default: 30 },
  { name: 'repayment_type', label: 'Repayments', type: 'select', options: [['pi', 'Principal & interest'], ['io', 'Interest only']], default: 'pi' },
  { name: 'application_ref', label: 'Lender application ref' },
  { name: 'pre_approval_expiry', label: 'Pre-approval expiry', type: 'date' },
  { name: 'finance_due_date', label: 'Finance due date', type: 'date' },
  { name: 'settlement_date', label: 'Settlement date', type: 'date' },
  { name: 'owner_id', label: 'Broker', type: 'select', options: userOptions },
  { name: 'referral_partner_id', label: 'Referral partner', type: 'select', options: partnerOptions },
];

export const taskFields = () => [
  { name: 'title', label: 'Task', required: true, full: true },
  { name: 'due_date', label: 'Due date', type: 'date' },
  { name: 'priority', label: 'Priority', type: 'select', options: opts(['low', 'normal', 'high']), required: true, default: 'normal' },
  { name: 'assigned_to', label: 'Assigned to', type: 'select', options: userOptions, default: state.user?.id },
  { name: 'description', label: 'Details', type: 'textarea', full: true },
];

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

export function newContact(values = {}, type = 'person') {
  const d = formModal(`New ${type === 'person' ? 'contact' : type}`, contactFields(type), values, async (v) => {
    const c = await attempt(() => api('/contacts', { method: 'POST', body: { ...v, entity_type: type } }), `${type === 'person' ? 'Contact' : label(type)} created`);
    location.hash = `#/contacts/${c.id}`;
  }, {
    before: entityTypeSwitch(type, (t) => {
      const form = d.querySelector('form');
      const keep = { email: form.elements.email?.value, phone: form.elements.phone?.value, status: form.elements.status?.value, owner_id: form.elements.owner_id?.value };
      d.close();
      newContact({ ...values, ...keep }, t);
    }),
  });
}

export async function newDeal(contactId, values = {}) {
  const fields = dealFields();
  // Co-borrowers: the client's partner to start with; add more, or a company or trust.
  const partner = contactId ? (await api(`/contacts/${contactId}/household`)).rows.find((m) => m.id !== Number(contactId)) : null;
  const who = await borrowersFieldset({ mainId: contactId || null, coIds: partner ? [partner.id] : [], chooseMain: !contactId });
  const parties = partiesFieldset();
  formModal('New deal', fields, values, async (v) => {
    const body = { ...v, contact_id: contactId, ...who.read(), parties: parties.read() };
    const d = await attempt(() => api('/deals', { method: 'POST', body }), 'Deal created');
    if (body.parties.some((p) => p.new_partner)) await loadLookups(true);
    location.hash = `#/deals/${d.id}`;
  }, { extra: parties.el, before: who.el });
}

export function newTask(context = {}) {
  formModal('New task', taskFields(), {}, async (v) => {
    await attempt(() => api('/tasks', { method: 'POST', body: { ...v, ...context } }), 'Task added');
    refresh();
  }, { wide: false });
}

export function taskTable(tasks) {
  if (!tasks.length) return h('p.empty', 'No tasks.');
  const today = new Date().toISOString().slice(0, 10);
  return h('ul.task-list', tasks.map((t) => h(`li${t.status === 'done' ? '.done' : ''}`,
    h('input', {
      type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark ${t.title} done`,
      onchange: async (e) => {
        await attempt(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'open' } }));
        refresh();
      },
    }),
    h('div',
      h('div', t.title, t.priority === 'high' ? h('span.badge.danger', 'High') : null, t.automation_id ? h('span.badge', { title: 'Created by automation' }, '⚡ auto') : null),
      h('div.muted',
        h(`span${t.status === 'open' && t.due_date && t.due_date < today ? '.text-danger' : ''}`, t.due_date ? `Due ${date(t.due_date)}` : 'No due date'),
        t.assigned_name ? ` · ${t.assigned_name}` : '')))));
}

// Activity timeline with a "log activity" form.
export function timeline(activities, { contactId, dealId }) {
  const fields = [
    { name: 'body', label: 'Log a note, call or meeting', type: 'textarea', required: true, rows: 3, full: true },
    { name: 'type', label: 'Type', type: 'select', required: true, default: 'note', options: opts(['note', 'call', 'email', 'sms', 'meeting']) },
  ];
  const form = h('form.log-form', fields.map((f) => field(f)), h('button', { type: 'submit' }, 'Log activity'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    if (!v.body) return toast('Please enter some details', 'error');
    await attempt(() => api(`/contacts/${contactId}/activities`, { method: 'POST', body: { ...v, deal_id: dealId || null } }), 'Logged');
    refresh();
  });
  return h('div', form,
    activities.length
      ? h('ul.activity-list', activities.map((a) => h(`li.act-${a.type}`,
        h('div.act-head', h('span.act-type', label(a.type)), h('span.muted', `${dateTime(a.created_at)}${a.user_name ? ` · ${a.user_name}` : ''}`),
          a.type !== 'system' ? h('button.link.small', {
            type: 'button',
            onclick: async () => { await attempt(() => api(`/activities/${a.id}`, { method: 'DELETE' }), 'Deleted'); refresh(); },
          }, 'Delete') : null),
        a.email_id
          ? h('button.link.act-body', { type: 'button', onclick: () => import('./email.js').then((m) => m.openEmail(a.email_id)) }, a.body)
          : h('div.act-body', a.body))))
      : h('p.empty', 'No activity yet.'));
}

export function emailList(emails) {
  if (!emails.length) return h('p.empty', 'No emails yet.');
  return h('ul.plain', emails.map((e) => h('li', h('span', e.subject), ' ', h(`span.badge.${e.status === 'failed' ? 'danger' : e.status === 'queued' ? 'warn' : 'ok'}`, e.status),
    h('div.muted', e.status === 'queued' ? `Scheduled ${dateTime(e.send_after)}` : dateTime(e.sent_at || e.send_after)))));
}

// Pick a template, preview it with merge fields filled in, then queue it.
// For a couple it can be addressed to one or both of them.
export async function sendTemplateDialog({ contactId, dealId, parties = [] }) {
  const [{ rows }, members] = await Promise.all([api('/templates'), householdOf(contactId, dealId)]);
  let addressees = defaultAddressees(members, contactId);
  let recipientRole = '';
  // The first person ticked is the main addressee ("Hi Tom" if only Tom).
  const body = () => ({
    contact_id: addressees.includes(Number(contactId)) ? contactId : addressees[0], deal_id: dealId, addressee_ids: addressees,
    recipient_role: recipientRole || undefined,
  });
  const select = h('select', { 'aria-label': 'Template' }, h('option', { value: '' }, 'Choose a template…'), rows.map((t) => h('option', { value: t.id }, `${t.name} (${label(t.category || 'general')})`)));
  const preview = h('div.email-preview', h('p.muted', 'Choose a template to preview it.'));
  const sendBtn = h('button', { type: 'button', disabled: true }, 'Send email');
  const previewBtn = h('button.secondary', {
    type: 'button',
    disabled: true,
    onclick: async () => (await import('./branding.js')).previewEmail({ template_id: select.value, ...body() }),
  }, 'Preview as email');
  const showPreview = async () => {
    sendBtn.disabled = !select.value;
    previewBtn.disabled = !select.value;
    if (!select.value) return;
    const p = await api(`/templates/${select.value}/preview`, { method: 'POST', body: body() });
    preview.replaceChildren(...[h('div.muted', `To: ${p.to || '(no email address)'}`), h('h3', p.subject), bodyPreview(p.body),
      p.sms ? h('div.sms-companion', h('strong.small', `Also texts ${p.mobile || '(no mobile – SMS will be skipped)'}:`), h('div.sms-bubble', p.sms)) : null].filter(Boolean));
  };
  select.addEventListener('change', showPreview);
  const picker = addresseePicker(members, addressees, (ids) => { addressees = ids; showPreview(); });
  // On a deal, it can go to the agent, solicitor etc. instead of the client.
  const withEmail = parties.filter((p) => p.email);
  const sendTo = withEmail.length ? h('select', {
    'aria-label': 'Send to',
    onchange: (e) => {
      recipientRole = e.target.value;
      if (picker) picker.hidden = Boolean(recipientRole);
      showPreview();
    },
  }, h('option', { value: '' }, 'Send to the client'), withEmail.map((p) => h('option', { value: p.role }, `Send to the ${p.role_label.toLowerCase()} – ${p.name}`))) : null;
  sendBtn.addEventListener('click', async () => {
    await attempt(() => api(`/templates/${select.value}/send`, { method: 'POST', body: body() }), 'Email sent');
    dialog.close();
    refresh();
  });
  const dialog = modal('Send email', [sendTo ? h('div.send-to', sendTo) : null, picker, select, preview, h('div.actions', previewBtn, sendBtn)], { wide: true });
}

// A couple who share finances get joint emails by default.
export const defaultAddressees = (members, contactId) => (members.length > 1 ? members.map((m) => m.id) : [Number(contactId)].filter(Boolean));

export { refresh, link };
