// Field definitions and shared widgets used across pages.
import {
  api, h, opts, userOptions, lenderOptions, partnerOptions, stageOptions, formModal, attempt, toast, state,
  date, dateTime, link, label, modal, field, readForm, fullName,
} from '../core.js';

export const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
export const CONTACT_STATUSES = ['lead', 'prospect', 'client', 'past_client', 'lost'];
export const LEAD_SOURCES = ['website', 'referral', 'walk_in', 'social', 'repeat', 'phone', 'other'];
export const LOAN_PURPOSES = ['purchase', 'first_home', 'refinance', 'investment', 'construction', 'top_up', 'commercial', 'other'];

export const contactFields = () => [
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
];

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

export function newContact(values = {}) {
  formModal('New contact', contactFields(), values, async (v) => {
    const c = await attempt(() => api('/contacts', { method: 'POST', body: v }), 'Contact created');
    location.hash = `#/contacts/${c.id}`;
  });
}

export async function newDeal(contactId, values = {}) {
  const fields = dealFields();
  if (!contactId) {
    const { rows } = await api('/contacts?limit=500');
    fields.unshift({ name: 'contact_id', label: 'Borrower', type: 'select', required: true, full: true, options: rows.map((c) => [c.id, fullName(c)]) });
  }
  formModal('New deal', fields, { ...values, contact_id: contactId }, async (v) => {
    const d = await attempt(() => api('/deals', { method: 'POST', body: { ...v, contact_id: contactId || v.contact_id } }), 'Deal created');
    location.hash = `#/deals/${d.id}`;
  });
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
export async function sendTemplateDialog({ contactId, dealId }) {
  const { rows } = await api('/templates');
  const select = h('select', { 'aria-label': 'Template' }, h('option', { value: '' }, 'Choose a template…'), rows.map((t) => h('option', { value: t.id }, `${t.name} (${label(t.category || 'general')})`)));
  const preview = h('div.email-preview', h('p.muted', 'Choose a template to preview it.'));
  const sendBtn = h('button', { type: 'button', disabled: true }, 'Send email');
  const previewBtn = h('button.secondary', {
    type: 'button',
    disabled: true,
    onclick: async () => (await import('./branding.js')).previewEmail({ template_id: select.value, contact_id: contactId, deal_id: dealId }),
  }, 'Preview as email');
  select.addEventListener('change', async () => {
    sendBtn.disabled = !select.value;
    previewBtn.disabled = !select.value;
    if (!select.value) return;
    const p = await api(`/templates/${select.value}/preview`, { method: 'POST', body: { contact_id: contactId, deal_id: dealId } });
    preview.replaceChildren(h('div.muted', `To: ${p.to || '(no email address)'}`), h('h3', p.subject), h('pre', p.body),
      p.sms ? h('div.sms-companion', h('strong.small', `Also texts ${p.mobile || '(no mobile – SMS will be skipped)'}:`), h('div.sms-bubble', p.sms)) : null);
  });
  sendBtn.addEventListener('click', async () => {
    await attempt(() => api(`/templates/${select.value}/send`, { method: 'POST', body: { contact_id: contactId, deal_id: dealId } }), 'Email sent');
    dialog.close();
    refresh();
  });
  const dialog = modal('Send email', [select, preview, h('div.actions', previewBtn, sendBtn)], { wide: true });
}

export { refresh, link };
