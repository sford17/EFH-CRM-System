// Outlook email: client conversations, reading/replying, composing, inbox and settings.
import {
  api, h, modal, attempt, toast, dateTime, pageHeader, table, field, readForm, state,
} from '../core.js';
import { previewEmail } from './branding.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const arrow = (dir) => h(`span.mail-dir.${dir}`, { title: dir === 'in' ? 'Received' : 'Sent' }, dir === 'in' ? '↙' : '↗');

// Compact list of synced emails for a contact or deal.
export function mailList(mail, { empty = 'No emails with this client yet.' } = {}) {
  if (!mail.length) return h('p.empty', empty);
  return h('ul.mail-list', mail.map((m) => h('li',
    h('button.mail-row', { type: 'button', onclick: () => openEmail(m.id) },
      arrow(m.direction),
      h('div.mail-main',
        h('div.mail-subject', m.subject || '(no subject)', m.has_attachments ? h('span.muted', { title: 'Has attachments' }, ' 📎') : null),
        h('div.muted.small', m.preview || '')),
      h('div.muted.small.mail-date', dateTime(m.sent_at))))));
}

export async function openEmail(id) {
  const e = await api(`/emails/${id}`);
  const replyBox = h('textarea', { rows: 6, placeholder: `Reply to ${e.direction === 'in' ? (e.from_name || e.from_email) : e.to_emails}…`, 'aria-label': 'Reply' });
  const sendBtn = h('button', { type: 'button' }, 'Send reply');
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    try {
      await attempt(() => api(`/emails/${id}/reply`, { method: 'POST', body: { body: replyBox.value } }), 'Reply sent from Outlook');
      d.close();
      setTimeout(refresh, 6000); // the sent reply is filed by the follow-up sync
    } finally {
      sendBtn.disabled = false;
    }
  });
  const d = modal(e.subject || '(no subject)', [
    h('dl.mail-meta',
      h('div', h('dt', 'From'), h('dd', e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email)),
      h('div', h('dt', 'To'), h('dd', (e.to_emails || '').split(',').join(', '))),
      e.cc_emails ? h('div', h('dt', 'Cc'), h('dd', e.cc_emails.split(',').join(', '))) : null,
      h('div', h('dt', 'Date'), h('dd', dateTime(e.sent_at))),
      h('div', h('dt', 'Client'), h('dd', e.contacts.map((c, i) => [i ? ', ' : '', h('a', { href: `#/contacts/${c.id}`, onclick: () => d.close() }, `${c.first_name} ${c.last_name || ''}`)]))),
      h('div', h('dt', 'Mailbox'), h('dd', e.mailbox_owner))),
    e.has_attachments ? h('p.muted.small', '📎 This email has attachments – open it in Outlook to view them.') : null,
    h('pre.email-body', e.body_text || e.preview || ''),
    e.web_link ? h('a', { href: e.web_link, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Outlook ↗') : null,
    e.can_reply
      ? h('div.reply-box', replyBox, h('div.actions', sendBtn))
      : h('p.muted.small', `Replies can only be sent from ${e.mailbox_owner}'s mailbox.`),
  ], { wide: true });
}

// New email to a contact, optionally starting from a template.
export async function composeDialog({ contactId, dealId, to }) {
  const [{ rows: templates }, status] = await Promise.all([api('/templates'), api('/outlook/status')]);
  const fields = [
    { name: 'to_email', label: 'To', type: 'email', required: true, full: true },
    { name: 'subject', label: 'Subject', required: true, full: true },
    { name: 'body', label: 'Message', type: 'textarea', rows: 12, required: true, full: true },
  ];
  const form = h('form.grid-form', fields.map((f) => field(f, f.name === 'to_email' ? to : undefined)));
  const templateSel = h('select', { 'aria-label': 'Start from a template' },
    h('option', { value: '' }, 'Start from a template (optional)…'),
    templates.map((t) => h('option', { value: t.id }, t.name)));
  templateSel.addEventListener('change', async () => {
    if (!templateSel.value) return;
    const p = await api(`/templates/${templateSel.value}/preview`, { method: 'POST', body: { contact_id: contactId, deal_id: dealId } });
    form.elements.subject.value = p.subject;
    form.elements.body.value = p.body;
  });
  const via = status.account?.connected
    ? h('p.muted.small', `Sends from your Outlook (${status.account.email}) and appears in your Sent Items. Your signature is added automatically.`)
    : h('p.small.text-warn', 'Your Outlook isn\'t connected, so this will only be logged, not sent. Connect it in Settings.');
  const send = h('button', { type: 'submit' }, 'Send');
  const preview = h('button.secondary', {
    type: 'button',
    onclick: () => previewEmail({ subject: form.elements.subject.value, body: form.elements.body.value || ' ' }),
  }, 'Preview');
  form.append(h('div.actions.full', preview, send));
  const d = modal('New email', [templateSel, form, via], { wide: true });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    send.disabled = true;
    try {
      const v = readForm(form, fields);
      const r = await attempt(() => api('/outbox', { method: 'POST', body: { ...v, contact_id: contactId || null, deal_id: dealId || null } }));
      if (r.status === 'failed') toast(`Not sent: ${r.error}`, 'error');
      else toast(r.sent_via === 'outlook' ? 'Sent from Outlook' : r.status === 'sent' ? 'Sent' : 'Logged (email not connected)');
      d.close();
      refresh();
    } finally {
      send.disabled = false;
    }
  });
}

// Emails card used on contact and deal pages.
export function emailsCard({ mail, outbox, contactId, dealId, to }) {
  const pending = outbox.filter((e) => e.status !== 'sent');
  return h('section.card',
    h('div.card-head', h('h2', 'Emails'),
      h('button.small', { type: 'button', onclick: () => composeDialog({ contactId, dealId, to }) }, '+ New email')),
    mailList(mail),
    outbox.length ? h('details.outbox-details',
      h('summary.muted.small', `Automated & queued emails (${outbox.length}${pending.length ? `, ${pending.length} not sent via Outlook` : ''})`),
      h('ul.plain', outbox.map((e) => h('li.small', e.subject, ' ',
        h(`span.badge.${e.status === 'failed' ? 'danger' : e.status === 'queued' ? 'warn' : 'ok'}`, e.status),
        h('div.muted', e.status === 'queued' ? `Scheduled ${dateTime(e.send_after)}` : dateTime(e.sent_at || e.send_after)))))) : null);
}

let inboxFilters = { direction: '', q: '' };

export async function inboxPage() {
  const [status] = await Promise.all([api('/outlook/status')]);
  const list = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(inboxFilters).filter(([, v]) => v)).toString();
    const { rows } = await api(`/emails?limit=300&${qs}`);
    list.replaceChildren(table([
      { label: '', value: (m) => arrow(m.direction) },
      { label: 'Client', value: (m) => (m.contact_id ? h('a', { href: `#/contacts/${m.contact_id}` }, m.contact_names) : m.contact_names) },
      { label: 'Email', value: (m) => h('div', h('strong', m.subject || '(no subject)'), m.has_attachments ? ' 📎' : '', h('div.muted.small', m.preview || '')) },
      { label: 'Mailbox', value: (m) => m.mailbox_owner },
      { label: 'Date', value: (m) => dateTime(m.sent_at) },
    ], rows, { onRow: (m) => openEmail(m.id), empty: status.account?.connected ? 'No client emails yet. They appear here after the next sync.' : 'No emails yet.' }));
  };
  const q = h('input', { type: 'search', placeholder: 'Search subject, message, address…', value: inboxFilters.q, 'aria-label': 'Search emails' });
  q.addEventListener('input', () => { inboxFilters.q = q.value; load(); });
  const dir = h('select', { 'aria-label': 'Direction' }, [['', 'Sent & received'], ['in', 'Received'], ['out', 'Sent']].map(([v, l]) => h('option', { value: v, selected: v === inboxFilters.direction }, l)));
  dir.addEventListener('change', () => { inboxFilters.direction = dir.value; load(); });
  const syncNow = async () => {
    const r = await attempt(() => api('/outlook/sync', { method: 'POST', body: {} }));
    toast(r.imported ? `Filed ${r.imported} new email(s)` : 'Up to date');
    load();
  };
  await load();
  return h('div',
    pageHeader('Client emails',
      status.account?.connected ? h('button.secondary', { type: 'button', onclick: syncNow }, 'Sync now') : null),
    status.account?.connected
      ? h('p.muted', `Emails between ${status.account.email} and your contacts, synced from Outlook every few minutes. Last sync: ${status.account.last_sync_at ? dateTime(status.account.last_sync_at) : 'pending'}.`)
      : h('div.alert.info', 'Connect your Outlook in ', h('a', { href: '#/settings' }, 'Settings'), ' to send and receive client emails from the CRM.'),
    status.account?.sync_error ? h('div.alert.danger', `Last sync failed: ${status.account.sync_error}`) : null,
    h('div.filters', q, dir),
    list);
}

// ---- Settings card -----------------------------------------------------------

export async function outlookSettingsCard() {
  const s = await api('/outlook/status');
  const isAdmin = state.user.role === 'admin';
  const redirectUri = `${location.origin}/api/outlook/callback`;
  const onLoopbackIp = location.hostname === '127.0.0.1';

  const connect = async () => {
    const { url } = await attempt(() => api('/outlook/connect', { method: 'POST', body: {} }));
    location.href = url;
  };
  const disconnect = async () => {
    await attempt(() => api('/outlook/disconnect', { method: 'POST', body: {} }), 'Outlook disconnected');
    refresh();
  };
  const syncNow = async () => {
    const r = await attempt(() => api('/outlook/sync', { method: 'POST', body: {} }));
    toast(r.imported ? `Filed ${r.imported} email(s)` : 'Up to date');
    refresh();
  };

  const mine = s.account?.connected
    ? h('div.outlook-status.ok',
      h('div', h('strong', `Connected: ${s.account.email}`),
        h('div.muted.small', `Last sync ${s.account.last_sync_at ? dateTime(s.account.last_sync_at) : 'pending – the first sync imports the last 30 days'}`),
        s.account.sync_error ? h('div.small.text-danger', s.account.sync_error) : null),
      h('div.actions', h('button.secondary.small', { type: 'button', onclick: syncNow }, 'Sync now'), h('button.danger.ghost.small', { type: 'button', onclick: disconnect }, 'Disconnect')))
    : h('div.outlook-status',
      h('div', h('strong', 'Your Outlook is not connected'),
        s.account?.sync_error ? h('div.small.text-danger', s.account.sync_error) : null,
        h('div.muted.small', s.configured ? 'Connect to send from your own mailbox and file client emails automatically.' : 'An admin needs to complete the Microsoft app setup below first.')),
      h('button', { type: 'button', disabled: !s.configured, onclick: connect }, 'Connect Outlook'));

  let adminSection = null;
  if (isAdmin) {
    const fields = [
      { name: 'client_id', label: 'Application (client) ID', required: true },
      { name: 'tenant', label: 'Directory (tenant) ID', placeholder: 'blank = any Microsoft account' },
      { name: 'client_secret', label: s.app.has_secret ? 'Client secret value (saved – enter only to change)' : 'Client secret value', type: 'password', required: !s.app.has_secret, full: true },
    ];
    const form = h('form.grid-form', fields.map((f) => field(f, f.name === 'client_secret' ? '' : s.app[f.name])),
      h('div.actions.full', h('button', { type: 'submit' }, 'Save Microsoft app details')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = readForm(form, fields);
      if (!v.client_secret) delete v.client_secret;
      await attempt(() => api('/outlook/config', { method: 'PUT', body: v }), 'Saved');
      refresh();
    });
    adminSection = h('details.outlook-setup', { open: !s.configured },
      h('summary', h('strong', s.configured ? 'Microsoft app setup (done)' : 'One-time setup (admin)')),
      h('ol.setup-steps',
        h('li', 'Sign in at ', h('a', { href: 'https://entra.microsoft.com', target: '_blank', rel: 'noopener noreferrer' }, 'entra.microsoft.com'), ' with your Microsoft 365 account and open ', h('strong', 'Applications → App registrations → New registration'), '.'),
        h('li', 'Name it ', h('strong', 'EFH CRM'), '. Under ', h('em', 'Supported account types'), ' choose ', h('strong', 'Accounts in this organizational directory only'), '.'),
        h('li', 'Under ', h('em', 'Redirect URI'), ' choose ', h('strong', 'Web'), ' and paste: ', h('code.copy', redirectUri), ' then click ', h('strong', 'Register'), '.'),
        h('li', 'Copy the ', h('strong', 'Application (client) ID'), ' and ', h('strong', 'Directory (tenant) ID'), ' from the Overview page into the boxes below.'),
        h('li', 'Open ', h('strong', 'Certificates & secrets → New client secret'), ', choose 24 months, then copy the secret\'s ', h('strong', 'Value'), ' (not the ID) below. Put a reminder in your calendar to renew it before it expires.'),
        h('li', 'Open ', h('strong', 'API permissions → Add a permission → Microsoft Graph → Delegated permissions'), ' and tick ', h('strong', 'Mail.ReadWrite, Mail.Send, offline_access, User.Read'), '. Then click ', h('strong', 'Grant admin consent'), '.'),
        h('li', 'Click ', h('strong', 'Save'), ' below, then ', h('strong', 'Connect Outlook'), ' above.')),
      form);
  }

  return h('section.card',
    h('h2', 'Outlook email'),
    onLoopbackIp ? h('div.alert.info.small', 'Tip: open the CRM at ', h('a', { href: `http://localhost:${location.port}/#/settings` }, `http://localhost:${location.port}`), ' (instead of 127.0.0.1) when connecting Outlook – Microsoft only accepts "localhost" addresses.') : null,
    mine,
    s.team.length > 1 ? h('details', h('summary.muted.small', 'Team mailboxes'),
      h('ul.plain', s.team.map((t) => h('li.small', `${t.name}: ${t.email || '—'} `, h(`span.badge.${t.connected ? 'ok' : ''}`, t.connected ? 'connected' : 'disconnected'))))) : null,
    adminSection);
}

