import {
  api, h, table, badge, fullName, date, money, pageHeader, formModal, attempt, confirmDialog, modal, stageLabel,
  opts, label, userOptions, toast, lenderTag,
} from '../core.js';
import {
  contactFields, newContact, newDeal, newTask, taskTable, timeline, sendTemplateDialog, refresh,
  CONTACT_STATUSES, LEAD_SOURCES,
} from './forms.js';
import { emailsCard, composeDialog } from './email.js';
import { smsCard, smsDialog } from './sms.js';
import { contactAppointmentsCard, bookingLinkDialog } from './calendar.js';
import { trackerTab } from './tracker.js';
import { reviewsCard, startReview } from './review.js';
import { refinancesCard } from './refinances.js';
import { relatedCard } from './household.js';
import { googleReviewInfo, requestReviewDialog } from './googleReview.js';
import { signingCard } from './signing.js';

const statusKind = { lead: 'info', prospect: 'warn', client: 'ok', past_client: '', lost: 'danger' };
const filters = { q: '', status: '', lead_source: '', owner_id: '', tag: '' };

export async function contactsPage() {
  // Links like #/contacts?tag=imported-2026-10-12 pre-set a filter.
  for (const key of Object.keys(filters)) {
    if (window.routeQuery?.has(key)) filters[key] = window.routeQuery.get(key);
  }
  const results = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    const { rows, total } = await api(`/contacts?limit=500&${qs}`);
    results.replaceChildren(
      h('p.muted', `${total} contact${total === 1 ? '' : 's'}`),
      table([
        { label: 'Name', value: (c) => h('a', { href: `#/contacts/${c.id}` }, fullName(c)) },
        { label: 'Status', value: (c) => badge(c.status, statusKind[c.status]) },
        { label: 'Email', value: (c) => c.email || '—' },
        { label: 'Mobile', value: (c) => c.mobile || '—' },
        { label: 'Source', value: (c) => label(c.lead_source || '—') },
        { label: 'Open deals', value: (c) => String(c.open_deals), class: 'num' },
        { label: 'Owner', value: (c) => c.owner_name || '—' },
        { label: 'Tags', value: (c) => (c.tags ? c.tags.split(',').map((t) => h('span.tag', t)) : '') },
      ], rows, { onRow: (c) => { location.hash = `#/contacts/${c.id}`; }, empty: 'No contacts match.' }),
    );
  };

  const control = (name, el) => {
    el.value = filters[name];
    el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { filters[name] = el.value; load(); });
    return el;
  };
  const select = (name, text, options) => control(name, h('select', { 'aria-label': text }, h('option', { value: '' }, text), options.map(([v, l]) => h('option', { value: v }, l))));

  await load();
  return h('div',
    pageHeader('Contacts',
      h('a.button.secondary', { href: '#/import' }, 'Import from spreadsheet'),
      h('a.button.secondary', { href: '/api/contacts/export.csv', download: 'contacts.csv' }, 'Export CSV'),
      h('button', { type: 'button', onclick: () => newContact() }, '+ New contact')),
    h('div.filters',
      control('q', h('input', { type: 'search', placeholder: 'Search name, email, mobile…', 'aria-label': 'Search contacts' })),
      select('status', 'All statuses', opts(CONTACT_STATUSES)),
      select('lead_source', 'All sources', opts(LEAD_SOURCES)),
      select('owner_id', 'All owners', userOptions()),
      control('tag', h('input', { type: 'search', placeholder: 'Tag', 'aria-label': 'Filter by tag' }))),
    results);
}

export async function contactPage(id) {
  const c = await api(`/contacts/${id}`);
  const tab = window.routeQuery?.get('tab') === 'tracker' ? 'tracker' : 'overview';
  const edit = () => formModal(`Edit ${fullName(c)}`, contactFields(), c, async (v) => {
    await attempt(() => api(`/contacts/${id}`, { method: 'PATCH', body: v }), 'Saved');
    refresh();
  });
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${fullName(c)} and all their deals, tasks and history? This cannot be undone.`))) return;
    await attempt(() => api(`/contacts/${id}`, { method: 'DELETE' }), 'Contact deleted');
    location.hash = '#/contacts';
  };
  const info = (k, v) => (v || v === 0 ? h('div.info-row', h('dt', k), h('dd', v)) : null);

  return h('div',
    h('div.page-header',
      h('div', h('h1', fullName(c), ' ', badge(c.status, statusKind[c.status])),
        h('div.muted', [c.email, c.mobile].filter(Boolean).join(' · '))),
      h('div.actions',
        c.email ? h('button.secondary', { type: 'button', onclick: () => composeDialog({ contactId: c.id, to: c.email }) }, 'Email') : null,
        c.mobile ? h('a.button.secondary', { href: `tel:${c.mobile.replace(/\s/g, '')}` }, 'Call') : null,
        c.mobile ? h('button.secondary', { type: 'button', onclick: () => smsDialog({ contactId: c.id, mobile: c.mobile, name: c.first_name }) }, 'SMS') : null,
        h('button.secondary', { type: 'button', onclick: () => bookingLinkDialog({ contact: c }) }, 'Booking link'),
        h('button.secondary', { type: 'button', onclick: () => startReview(c.id) }, 'Lending review'),
        h('button.secondary', { type: 'button', onclick: () => sendTemplateDialog({ contactId: c.id }) }, 'Send template'),
        h('button.secondary', { type: 'button', onclick: () => requestReviewDialog({ contact: c }) }, '⭐ Review request'),
        h('button.secondary', { type: 'button', onclick: edit }, 'Edit'),
        h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete'))),
    h('nav.tabs', { 'aria-label': 'Contact sections' },
      h(`a${tab === 'overview' ? '.active' : ''}`, { href: `#/contacts/${c.id}`, 'aria-current': tab === 'overview' ? 'page' : undefined }, 'Overview'),
      h(`a${tab === 'tracker' ? '.active' : ''}`, { href: `#/contacts/${c.id}?tab=tracker`, 'aria-current': tab === 'tracker' ? 'page' : undefined }, 'Mortgage tracker')),
    tab === 'tracker' ? h('div', await trackerTab(c), await refinancesCard(c), reviewsCard(c.id, c.reviews)) : h('div.detail-grid',
      h('div.col-side',
        h('section.card', h('h2', 'Details'), h('dl.info',
          info('Owner', c.owner_name),
          info('Lead source', label(c.lead_source || '')),
          info('Referred by', c.partner_name),
          info('Date of birth', c.dob ? date(c.dob) : null),
          info('Address', [c.address, c.suburb, c.state, c.postcode].filter(Boolean).join(', ')),
          info('Employment', c.employment_type ? `${label(c.employment_type)}${c.employer ? ` – ${c.employer}` : ''}` : null),
          info('Annual income', c.annual_income ? money(c.annual_income) : null),
          info('Marital status', label(c.marital_status || '')),
          info('Dependants', c.dependants),
          info('Last contacted', c.last_contacted_at ? date(c.last_contacted_at) : 'Never'),
          info('Next review', c.next_review_date ? date(c.next_review_date) : null),
          info('Marketing', c.marketing_opt_in ? 'Opted in' : 'Opted out'),
          info('Google review', googleReviewInfo(c)),
          c.sms_opt_out ? info('SMS', h('span.text-danger', 'Opted out of all SMS')) : null,
          info('Tags', c.tags ? c.tags.split(',').map((t) => h('span.tag', t)) : null)),
        c.background ? h('div.background', h('h3', 'Background'), h('p.pre', c.background)) : null),
        relatedCard(c),
        h('section.card',
          h('div.card-head', h('h2', 'Deals'), h('button.small', { type: 'button', onclick: () => newDeal(c.id) }, '+ Deal')),
          c.deals.length
            ? h('ul.plain', c.deals.map((d) => h('li', h('a', { href: `#/deals/${d.id}` }, d.title),
              h('div.muted', `${stageLabel(d.stage)} · ${money(d.loan_amount)}`, d.lender_name ? [' · ', lenderTag(d.lender_logo_id, d.lender_name)] : null),
              c.household.length > 1 ? h('div.muted.small', [d.contact_name, d.co_borrower_name].filter(Boolean).map((n) => n.trim()).join(' & ')) : null)))
            : h('p.empty', 'No deals yet.')),
        h('section.card',
          h('div.card-head', h('h2', 'Tasks'), h('button.small', { type: 'button', onclick: () => newTask({ contact_id: c.id }) }, '+ Task')),
          taskTable(c.tasks)),
        signingCard({ requests: c.sign_requests, contact: c }),
        emailsCard({ mail: c.mail, outbox: c.emails, contactId: c.id, to: c.email }),
        smsCard({ sms: c.sms, contactId: c.id, mobile: c.mobile, name: c.first_name }),
        contactAppointmentsCard(c),
        reviewsCard(c.id, c.reviews)),
      h('div.col-main',
        h('section.card', h('h2', 'Activity'), timeline(c.activities, { contactId: c.id })))));
}
