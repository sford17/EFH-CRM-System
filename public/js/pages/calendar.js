// Calendly: appointments page, booking-link dialog, cards and settings.
import { api, h, modal, attempt, toast, dateTime, pageHeader, state, badge, fullName } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const time = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const dayLabel = (iso) => {
  const d = new Date(iso);
  const t = new Date();
  const key = (x) => x.toDateString();
  if (key(d) === key(t)) return 'Today';
  if (key(d) === key(new Date(t.getTime() + 86400000))) return 'Tomorrow';
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
};

function apptRow(a, { showOwner = false } = {}) {
  const who = a.contact_id ? h('a', { href: `#/contacts/${a.contact_id}` }, a.contact_name || a.invitee_name) : (a.invitee_name || a.invitee_email || 'Unknown');
  return h(`li.appt${a.status === 'canceled' ? '.cancelled' : ''}`,
    h('div.appt-time', time(a.start_at), a.end_at ? h('span.muted', `–${time(a.end_at)}`) : null),
    h('div.appt-main',
      h('div', h('strong', a.title), ' with ', who,
        a.status === 'canceled' ? badge(a.rescheduled ? 'rescheduled' : 'cancelled', a.rescheduled ? 'warn' : 'danger') : null),
      h('div.muted.small',
        [a.location, showOwner ? a.owner_name : null, a.deal_title].filter(Boolean).join(' · '),
        a.cancel_reason ? ` · Reason: ${a.cancel_reason}` : ''),
      a.notes ? h('details.small', h('summary.muted', 'Booking answers'), h('div.pre', a.notes)) : null),
    h('div.appt-actions',
      a.join_url && a.status !== 'canceled' ? h('a.button.small', { href: a.join_url, target: '_blank', rel: 'noopener noreferrer' }, 'Join') : null,
      a.reschedule_url && a.status !== 'canceled' ? h('a.button.secondary.small', { href: a.reschedule_url, target: '_blank', rel: 'noopener noreferrer' }, 'Reschedule') : null));
}

function groupedByDay(rows, opts) {
  const groups = new Map();
  for (const a of rows) {
    const k = new Date(a.start_at).toDateString();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups.values()].map((list) => h('section.card', h('h2', dayLabel(list[0].start_at)), h('ul.appt-list', list.map((a) => apptRow(a, opts)))));
}

let filters = { mine: '1', when: 'upcoming', include_cancelled: '' };

export async function calendarPage() {
  const status = await api('/calendly/status');
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { rows } = await api(`/appointments?${qs}`);
  const sel = (key, options) => {
    const el = h('select', { 'aria-label': key }, options.map(([v, l]) => h('option', { value: v, selected: filters[key] === v }, l)));
    el.addEventListener('change', () => { filters[key] = el.value; refresh(); });
    return el;
  };
  const syncNow = async () => {
    const r = await attempt(() => api('/calendly/sync', { method: 'POST', body: {} }));
    toast(r.new_events ? `${r.new_events} new booking change(s)` : 'Up to date');
    refresh();
  };
  const connected = status.account?.connected;
  return h('div',
    pageHeader('Calendar',
      connected ? h('button.secondary', { type: 'button', onclick: syncNow }, 'Sync now') : null,
      connected ? h('button', { type: 'button', onclick: () => bookingLinkDialog({}) }, 'My booking link') : null),
    connected
      ? h('p.muted', `Bookings from Calendly (${status.account.scheduling_url}), checked every few minutes. Last sync: ${status.account.last_sync_at ? dateTime(status.account.last_sync_at) : 'pending'}.`)
      : h('div.alert.info', 'Connect your Calendly account in ', h('a', { href: '#/settings' }, 'Settings'), ' to see your bookings here.'),
    status.account?.sync_error ? h('div.alert.danger', status.account.sync_error) : null,
    h('div.filters',
      sel('mine', [['1', 'My appointments'], ['', 'Everyone\'s']]),
      sel('when', [['upcoming', 'Upcoming'], ['past', 'Past']]),
      sel('include_cancelled', [['', 'Hide cancelled'], ['1', 'Show cancelled']])),
    rows.length ? groupedByDay(rows, { showOwner: !filters.mine }) : h('p.empty', filters.when === 'past' ? 'No past appointments.' : 'No upcoming appointments.'));
}

// Dashboard card.
export function upcomingCard(appointments) {
  return h('section.card',
    h('div.card-head', h('h2', 'Upcoming appointments'), h('a.small', { href: '#/calendar' }, 'Calendar →')),
    appointments.length
      ? h('ul.appt-list.compact', appointments.map((a) => h('li.appt',
        h('div.appt-time', h('div.small.muted', dayLabel(a.start_at)), time(a.start_at)),
        h('div.appt-main', h('strong', a.title), h('div.muted.small',
          a.contact_id ? h('a', { href: `#/contacts/${a.contact_id}` }, a.contact_name) : (a.invitee_name || ''))),
        h('div.appt-actions', a.join_url ? h('a.button.small', { href: a.join_url, target: '_blank', rel: 'noopener noreferrer' }, 'Join') : null))))
      : h('p.empty', 'Nothing booked in the next week.'));
}

// Contact page card.
export function contactAppointmentsCard(contact) {
  const list = contact.appointments || [];
  return h('section.card',
    h('div.card-head', h('h2', 'Appointments'),
      h('button.small', { type: 'button', onclick: () => bookingLinkDialog({ contact }) }, 'Send booking link')),
    list.length
      ? h('ul.appt-list', list.map((a) => h(`li.appt${a.status === 'canceled' ? '.cancelled' : ''}`,
        h('div.appt-time', h('div.small.muted', new Date(a.start_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })), time(a.start_at)),
        h('div.appt-main', h('strong', a.title),
          a.status === 'canceled' ? badge(a.rescheduled ? 'rescheduled' : 'cancelled', a.rescheduled ? 'warn' : 'danger') : null,
          new Date(a.start_at) < new Date() && a.status !== 'canceled' ? h('span.muted.small', ' (past)') : null,
          a.notes ? h('div.muted.small.pre', a.notes) : null))))
      : h('p.empty', 'No appointments yet.'));
}

// Pick a meeting type, then copy, email or text the (pre-filled) link.
export async function bookingLinkDialog({ contact = null }) {
  const { links } = await attempt(() => api(`/calendly/links${contact ? `?contact_id=${contact.id}` : ''}`));
  const select = h('select', { 'aria-label': 'Meeting type' },
    links.map((l, i) => h('option', { value: i }, l.duration ? `${l.name} (${l.duration} min)` : l.name)));
  const output = h('input', { type: 'text', readonly: true, 'aria-label': 'Booking link', class: 'link-output' });
  const current = () => links[Number(select.value)];
  const update = () => { output.value = current().url; };
  select.addEventListener('change', update);
  update();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output.value);
    } catch {
      output.select();
      document.execCommand('copy');
    }
    toast('Link copied – paste it anywhere');
  };
  const first = contact?.first_name || '';
  const me = state.user.name.split(' ')[0];
  const email = async () => {
    d.close();
    const { composeDialog } = await import('./email.js');
    composeDialog({
      contactId: contact?.id, to: contact?.email,
      subject: 'Book a time to chat',
      body: `Hi ${first},\n\nYou can book a time that suits you here:\n${current().url}\n\nIt only takes a few seconds, and you'll get a calendar invite straight away.\n\nKind regards,`,
    });
  };
  const text = async () => {
    d.close();
    const { smsDialog } = await import('./sms.js');
    smsDialog({ contactId: contact.id, mobile: contact.mobile, name: first, body: `Hi ${first}, here's a link to book a time with me: ${current().short_url} - ${me}` });
  };

  const d = modal(contact ? `Booking link for ${fullName(contact)}` : 'My booking link', [
    select,
    h('div.link-row', output, h('button', { type: 'button', onclick: copy }, 'Copy')),
    contact ? h('p.muted.small', `Pre-filled with ${first}'s details. When they book, the appointment is linked to their record automatically.`) : null,
    contact ? h('div.actions',
      contact.email ? h('button.secondary', { type: 'button', onclick: email }, 'Email it') : null,
      contact.mobile ? h('button.secondary', { type: 'button', onclick: text }, 'Text it') : null) : null,
  ]);
}

export async function calendlySettingsCard() {
  const s = await api('/calendly/status');
  const token = h('input', { type: 'password', placeholder: 'Paste your Calendly personal access token', 'aria-label': 'Calendly personal access token', autocomplete: 'off' });
  const connect = async () => {
    const r = await attempt(() => api('/calendly/connect', { method: 'POST', body: { token: token.value } }));
    toast(r.sync?.error ? `Connected, but the first sync failed: ${r.sync.error}` : `Connected – ${r.sync.synced} appointment(s) imported`, r.sync?.error ? 'error' : 'ok');
    refresh();
  };
  const disconnect = async () => {
    await attempt(() => api('/calendly/disconnect', { method: 'POST', body: {} }), 'Calendly disconnected');
    refresh();
  };
  const syncNow = async () => {
    const r = await attempt(() => api('/calendly/sync', { method: 'POST', body: {} }));
    toast(r.new_events ? `${r.new_events} new booking change(s)` : 'Up to date');
    refresh();
  };
  const leads = h('input', { type: 'checkbox', checked: s.create_leads, disabled: state.user.role !== 'admin' });
  leads.addEventListener('change', () => attempt(() => api('/calendly/settings', { method: 'PUT', body: { create_leads: leads.checked } }), 'Saved'));

  const a = s.account;
  return h('section.card',
    h('h2', 'Calendly'),
    a?.connected
      ? h('div.outlook-status.ok',
        h('div', h('strong', `Connected: ${a.name || a.email}`),
          h('div.muted.small', `Booking page ${a.scheduling_url} · last sync ${a.last_sync_at ? dateTime(a.last_sync_at) : 'pending'}`),
          a.sync_error ? h('div.small.text-danger', a.sync_error) : null),
        h('div.actions',
          h('button.secondary.small', { type: 'button', onclick: syncNow }, 'Sync now'),
          h('button.danger.ghost.small', { type: 'button', onclick: disconnect }, 'Disconnect')))
      : h('div',
        a?.sync_error ? h('div.alert.danger.small', a.sync_error) : null,
        h('ol.setup-steps',
          h('li', 'Sign in to Calendly and open ', h('a', { href: 'https://calendly.com/integrations/api_webhooks', target: '_blank', rel: 'noopener noreferrer' }, 'Integrations → API & Webhooks'), '.'),
          h('li', 'Under ', h('strong', 'Personal access tokens'), ' click ', h('strong', 'Generate new token'), ', name it "EFH CRM" and copy the token (Calendly shows it only once).'),
          h('li', 'Paste it below and click ', h('strong', 'Connect'), '. Works on every Calendly plan, including the free one.')),
        h('div.link-row', token, h('button', { type: 'button', onclick: connect }, 'Connect'))),
    h('label.field.check', leads, 'When someone not in the CRM books, add them as a new lead'),
    h('p.muted.small', 'Bookings appear within a few minutes. Each team member connects their own Calendly. Use {{broker.booking_link}} in email templates and SMS to include your booking link.'));
}
