import { api, h, pageHeader, table, badge, dateTime, attempt, confirmDialog, label, formModal, modal, toast } from '../core.js';
import { refresh } from './forms.js';
import { smsLog, counted } from './sms.js';

const MERGE_HELP = 'Your email signature is added automatically when the email is sent, so end the message with something like "Kind regards,". Merge fields: {{contact.first_name}} {{contact.full_name}} {{deal.title}} {{deal.loan_amount|money}} {{deal.lender_name}} {{deal.settlement_date|date}} {{deal.fixed_expiry_date|date}} {{deal.pre_approval_expiry|date}} {{deal.outstanding_documents}} {{broker.name}} {{broker.phone}} {{business.name}}. Templates in the "marketing" category are not sent to contacts who opted out.';

const templateFields = [
  { name: 'name', label: 'Name', required: true },
  { name: 'category', label: 'Category', type: 'select', options: ['onboarding', 'application', 'settlement', 'retention', 'marketing', 'general'].map((c) => [c, label(c)]) },
  { name: 'subject', label: 'Subject', required: true, full: true },
  { name: 'body', label: 'Body', type: 'textarea', rows: 14, required: true, full: true },
  { name: 'sms_body', label: 'Also send this SMS whenever this email is sent (optional – same merge fields)', type: 'textarea', rows: 3, full: true },
];

export async function templatesPage() {
  const { rows } = await api('/templates');
  const edit = (t) => {
    const d = formModal(t ? `Edit "${t.name}"` : 'New template', templateFields, t || { category: 'general' }, async (v) => {
      await attempt(() => api(t ? `/templates/${t.id}` : '/templates', { method: t ? 'PATCH' : 'POST', body: v }), 'Template saved');
      refresh();
    });
    d.querySelector('form').prepend(h('p.muted.small.full', MERGE_HELP));
    const smsBox = d.querySelector('textarea[name=sms_body]');
    smsBox.after(counted(smsBox));
  };
  return h('div',
    pageHeader('Email templates', h('button', { type: 'button', onclick: () => edit() }, '+ New template')),
    h('p.muted', 'Templates are used by automations and can be sent manually from any contact or deal.'),
    table([
      { label: 'Name', value: (t) => h('a', { href: '#/templates', onclick: (e) => { e.preventDefault(); edit(t); } }, t.name) },
      { label: 'Category', value: (t) => badge(t.category || 'general') },
      { label: 'Subject', value: (t) => t.subject },
      { label: 'SMS', value: (t) => (t.sms_body ? h('span', { title: t.sms_body }, '✓ also texts') : '') },
      {
        label: '', value: (t) => h('button.link.small', {
          type: 'button',
          onclick: async () => { if (await confirmDialog(`Delete template "${t.name}"? Automations using it will skip that email.`)) { await attempt(() => api(`/templates/${t.id}`, { method: 'DELETE' }), 'Deleted'); refresh(); } },
        }, 'Delete'),
      },
    ], rows, { onRow: edit }));
}

let outboxStatus = '';

export async function outboxPage() {
  const [{ rows }, sms] = await Promise.all([api(`/outbox${outboxStatus ? `?status=${outboxStatus}` : ''}`), smsLog()]);
  const status = h('select', { 'aria-label': 'Status' }, ['', 'queued', 'sent', 'logged', 'failed', 'cancelled'].map((s) => h('option', { value: s, selected: s === outboxStatus }, s ? label(s) : 'All emails')));
  status.addEventListener('change', () => { outboxStatus = status.value; refresh(); });
  const view = (m) => modal(m.subject, [h('div.muted', `To: ${m.to_email} · ${label(m.status)}${m.error ? ` · ${m.error}` : ''}`), h('pre.email-body', m.body)], { wide: true });
  return h('div',
    pageHeader('Outbox', status,
      h('button', { type: 'button', onclick: async () => { const r = await attempt(() => api('/outbox/process', { method: 'POST', body: {} })); toast(`Processed ${r.processed} email(s)`); refresh(); } }, 'Send due emails now')),
    h('p.muted', 'Emails queued by automations and by you. Without SMTP settings, emails are marked "logged" instead of being sent – see the README to connect your mailbox.'),
    table([
      { label: 'Created', value: (m) => dateTime(m.created_at) },
      { label: 'To', value: (m) => (m.contact_id ? h('a', { href: `#/contacts/${m.contact_id}` }, m.contact_name || m.to_email) : m.to_email) },
      { label: 'Subject', value: (m) => m.subject },
      { label: 'Source', value: (m) => m.automation_name ? h('span', { title: m.automation_name }, '⚡ automation') : 'manual' },
      { label: 'Status', value: (m) => h('div', badge(m.status, { failed: 'danger', queued: 'warn', sent: 'ok', logged: 'info' }[m.status]), m.status === 'queued' ? h('div.muted.small', `after ${dateTime(m.send_after)}`) : null) },
      {
        label: '', value: (m) => (m.status === 'queued'
          ? h('button.link.small', { type: 'button', onclick: async () => { await attempt(() => api(`/outbox/${m.id}/cancel`, { method: 'POST', body: {} }), 'Cancelled'); refresh(); } }, 'Cancel')
          : ['failed', 'cancelled'].includes(m.status)
            ? h('button.link.small', { type: 'button', onclick: async () => { await attempt(() => api(`/outbox/${m.id}/retry`, { method: 'POST', body: {} }), 'Re-queued'); refresh(); } }, 'Retry')
            : null),
      },
    ], rows, { onRow: view, empty: 'No emails.' }),
    sms);
}
