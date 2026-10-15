// Lenders: commission rates, logos, your accreditation numbers, BDM and other
// lender contacts, and emailing them (filed against the client when the
// email is about one).
import {
  api, h, pageHeader, table, badge, money, pct, attempt, confirmDialog, label, formModal, modal, state, loadLookups,
  field, readForm, toast, date, dateTime, fullName, stageLabel, lenderLogo, todayStr,
} from '../core.js';
import { lenderFields, logoCell } from './admin.js';
import { mailList } from './email.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const ROLE_LABELS = { bdm: 'BDM', assistant_bdm: 'Assistant BDM', scenario_desk: 'Scenario desk', credit: 'Credit', settlements: 'Settlements', broker_support: 'Broker support', other: 'Other' };
const STATUS_LABELS = { active: 'Accredited', pending: 'Pending', suspended: 'Suspended', not_accredited: 'Not accredited' };
const STATUS_KIND = { active: 'ok', pending: 'warn', suspended: 'danger', not_accredited: '' };
const inDays = (d, n) => { const x = new Date(`${todayStr()}T00:00:00`); x.setDate(x.getDate() + n); return d <= `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

function renewalNote(due) {
  if (!due) return null;
  if (due < todayStr()) return h('span.text-danger.small', `Renewal overdue (${date(due)})`);
  if (inDays(due, 60)) return h('span.text-warn.small', `Renewal due ${date(due)}`);
  return h('span.muted.small', `Renews ${date(due)}`);
}

const accreditationBadge = (status) => (status ? h(`span.badge${STATUS_KIND[status] ? `.${STATUS_KIND[status]}` : ''}`, STATUS_LABELS[status]) : null);

// ---- Lenders list -------------------------------------------------------------------

let search = '';

export async function lendersPage() {
  const { rows } = await api('/lenders');
  const list = h('div');
  const render = () => {
    const q = search.trim().toLowerCase();
    const shown = rows.filter((l) => !q || [l.name, l.bdm_name, l.accreditation_number].some((v) => String(v || '').toLowerCase().includes(q)));
    list.replaceChildren(table([
      { label: 'Logo', value: (l) => logoCell(l) },
      { label: 'Lender', value: (l) => h('div', h('a', { href: `#/lenders/${l.id}` }, h('strong', l.name)), l.active ? null : [' ', badge('inactive')], l.website ? h('div.muted.small', l.website) : null) },
      {
        label: 'My accreditation',
        value: (l) => (l.accreditation_status
          ? h('div', h('div', h('strong.mono', l.accreditation_number || '—'), ' ', accreditationBadge(l.accreditation_status)), renewalNote(l.renewal_due))
          : h('button.link.small', { type: 'button', onclick: () => accreditationDialog({ lender: l, userId: state.user.id }) }, '+ Add number')),
      },
      {
        label: 'BDM',
        value: (l) => (l.bdm_name
          ? h('div', h('div', l.bdm_name), h('div.row-actions.small',
            l.bdm_email ? h('button.link.small', { type: 'button', onclick: () => emailLenderDialog({ lenderId: l.id }) }, '✉ Email') : null,
            l.bdm_phone ? h('a', { href: `tel:${l.bdm_phone.replace(/\s/g, '')}` }, l.bdm_phone) : null))
          : h('button.link.small', { type: 'button', onclick: () => contactDialog({ lenderId: l.id }) }, '+ Add BDM')),
      },
      { label: 'Open deals', value: (l) => String(l.open_deals), class: 'num' },
      { label: 'Settled', value: (l) => `${l.settled_count} · ${money(l.settled_volume)}`, class: 'num' },
      { label: 'Upfront', value: (l) => pct(l.upfront_pct), class: 'num' },
    ], shown, { onRow: (l) => { location.hash = `#/lenders/${l.id}`; }, empty: 'No lenders match.' }));
  };
  const box = h('input', { type: 'search', placeholder: 'Search lender, BDM or accreditation number…', value: search, 'aria-label': 'Search lenders' });
  box.addEventListener('input', () => { search = box.value; render(); });
  render();
  return h('div',
    pageHeader('Lenders', h('button', { type: 'button', onclick: () => editLender() }, '+ Add lender')),
    h('p.muted', 'Your accreditation numbers, BDMs and commission rates for each lender. Click a lender to see all its contacts, your team\'s accreditations and your emails with them.'),
    h('div.filters', box),
    list);
}

function editLender(l) {
  formModal(l ? `Edit ${l.name}` : 'New lender', lenderFields, l || {}, async (v) => {
    const saved = await attempt(() => api(l ? `/lenders/${l.id}` : '/lenders', { method: l ? 'PATCH' : 'POST', body: v }), 'Saved');
    await loadLookups(true);
    if (!l) location.hash = `#/lenders/${saved.id}`;
    else refresh();
  });
}

// ---- One lender -------------------------------------------------------------------

export async function lenderPage(id) {
  const l = await api(`/lenders/${id}`);
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${l.name}, its contacts and accreditation records? Existing deals keep their history but lose the link.`))) return;
    await attempt(() => api(`/lenders/${l.id}`, { method: 'DELETE' }), 'Lender deleted');
    await loadLookups(true);
    location.hash = '#/lenders';
  };
  const info = (k, v) => (v || v === 0 ? h('div.info-row', h('dt', k), h('dd', v)) : null);

  return h('div',
    h('div.page-header',
      h('div.lender-title', lenderLogo(l.logo_asset_id, l.name, 'md'), h('div', h('h1', l.name, l.active ? null : [' ', badge('inactive')]),
        l.website ? h('a.muted', { href: `https://${l.website.replace(/^https?:\/\//, '')}`, target: '_blank', rel: 'noopener noreferrer' }, l.website) : null)),
      h('div.actions',
        h('a.button.secondary', { href: '#/lenders' }, '← Lenders'),
        h('button', { type: 'button', onclick: () => emailLenderDialog({ lenderId: l.id, lender: l }) }, '✉ Email BDM'),
        h('button.secondary', { type: 'button', onclick: () => editLender(l) }, 'Edit'),
        h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete'))),
    h('div.detail-grid',
      h('div.col-side',
        accreditationCard(l),
        h('section.card', h('h2', 'Commission & notes'), h('dl.info',
          info('Upfront', pct(l.upfront_pct)),
          info('Clawback', `${l.clawback_months} months`),
          info('Logo', logoCell(l))),
        l.notes ? h('div.background', h('h3', 'Notes'), h('p.pre', l.notes)) : null)),
      h('div.col-main',
        contactsCard(l),
        lenderEmailsCard(l),
        h('section.card', h('h2', `Open deals (${l.deals.length})`),
          table([
            { label: 'Deal', value: (d) => h('a', { href: `#/deals/${d.id}` }, d.title) },
            { label: 'Client', value: (d) => h('a', { href: `#/contacts/${d.contact_id}` }, d.contact_name) },
            { label: 'Stage', value: (d) => stageLabel(d.stage) },
            { label: 'Lender ref', value: (d) => d.application_ref || '—' },
            { label: 'Amount', value: (d) => money(d.loan_amount), class: 'num' },
            { label: '', value: (d) => h('button.link.small', { type: 'button', onclick: () => emailLenderDialog({ lenderId: l.id, lender: l, contactId: d.contact_id, dealId: d.id }) }, '✉ Email BDM') },
          ], l.deals, { empty: `No open deals with ${l.name}.` })))));
}

function accreditationCard(l) {
  const mine = l.accreditations.find((a) => a.user_id === state.user.id);
  const others = l.accreditations.filter((a) => a.user_id !== state.user.id);
  const isAdmin = state.user.role === 'admin';
  const missing = state.users.filter((u) => u.active && !l.accreditations.some((a) => a.user_id === u.id) && u.id !== state.user.id);
  const row = (a, own) => h('li.accreditation',
    h('div', own ? h('strong', 'You') : h('strong', a.user_name), ' ', accreditationBadge(a.status)),
    h('div.mono.accreditation-number', a.accreditation_number || 'No number recorded'),
    h('div.muted.small', [a.accredited_on ? `Accredited ${date(a.accredited_on)}` : null].filter(Boolean).join(''), a.accredited_on && a.renewal_due ? ' · ' : '', renewalNote(a.renewal_due)),
    a.notes ? h('div.small', a.notes) : null,
    own || isAdmin ? h('div.row-actions',
      h('button.link.small', { type: 'button', onclick: () => accreditationDialog({ lender: l, userId: a.user_id, existing: a }) }, 'Edit'),
      h('button.link.small', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog(`Remove ${own ? 'your' : `${a.user_name}'s`} accreditation record for ${l.name}?`))) return;
          await attempt(() => api(`/lenders/accreditations/${a.id}`, { method: 'DELETE' }), 'Removed');
          refresh();
        },
      }, 'Remove')) : null);
  return h('section.card',
    h('div.card-head', h('h2', 'Accreditation'),
      isAdmin && missing.length ? h('select.small', {
        'aria-label': 'Add a team member\'s accreditation',
        onchange: (e) => { if (e.target.value) accreditationDialog({ lender: l, userId: Number(e.target.value) }); e.target.value = ''; },
      }, h('option', { value: '' }, '+ Team member…'), missing.map((u) => h('option', { value: u.id }, u.name))) : null),
    h('ul.plain.accreditation-list',
      mine ? row(mine, true) : h('li', h('p.empty', `No accreditation number recorded for you with ${l.name}.`),
        h('button.small', { type: 'button', onclick: () => accreditationDialog({ lender: l, userId: state.user.id }) }, '+ Add my accreditation')),
      others.map((a) => row(a, false))));
}

function accreditationDialog({ lender, userId, existing = null }) {
  const user = state.users.find((u) => u.id === userId);
  const own = userId === state.user.id;
  formModal(`${own ? 'Your' : `${user?.name || 'Team member'}'s`} accreditation – ${lender.name}`, [
    { name: 'accreditation_number', label: 'Accreditation / broker ID number', full: true, placeholder: 'e.g. 123456' },
    { name: 'status', label: 'Status', type: 'select', required: true, default: 'active', options: Object.entries(STATUS_LABELS) },
    { name: 'accredited_on', label: 'Accredited on', type: 'date' },
    { name: 'renewal_due', label: 'Renewal / re-accreditation due', type: 'date' },
    { name: 'notes', label: 'Notes (e.g. aggregator, portal login hint – never passwords)', type: 'textarea', rows: 2, full: true },
  ], existing || {}, async (v) => {
    await attempt(() => api(`/lenders/${lender.id}/accreditations/${userId}`, { method: 'PUT', body: v }), 'Accreditation saved');
    refresh();
  }, { wide: false });
}

function contactsCard(l) {
  const remove = async (c) => {
    if (!(await confirmDialog(`Remove ${c.name} from ${l.name}'s contacts?`))) return;
    await attempt(() => api(`/lenders/contacts/${c.id}`, { method: 'DELETE' }), 'Removed');
    refresh();
  };
  return h('section.card',
    h('div.card-head', h('h2', 'BDM & lender contacts'), h('button.small', { type: 'button', onclick: () => contactDialog({ lenderId: l.id }) }, '+ Add contact')),
    l.contacts.length
      ? h('ul.plain.lender-contacts', l.contacts.map((c) => h('li',
        h('div', h('strong', c.name), ' ', h('span.badge', c.role_label), c.is_primary ? h('span.badge.ok', { title: 'Shown on the Lenders list' }, 'Main contact') : null,
          c.region ? h('span.muted.small', ` · ${c.region}`) : null),
        h('div.party-contact.small',
          c.email ? h('button.link.small', { type: 'button', onclick: () => emailLenderDialog({ lenderId: l.id, lender: l, to: c.email }) }, `✉ ${c.email}`) : null,
          [c.mobile, c.phone].filter(Boolean).map((n) => h('a', { href: `tel:${n.replace(/\s/g, '')}` }, n))),
        c.notes ? h('div.small', c.notes) : null,
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => contactDialog({ lenderId: l.id, existing: c }) }, 'Edit'),
          h('button.link.small', { type: 'button', onclick: () => remove(c) }, 'Remove')))))
      : h('p.empty', `No contacts yet. Add your BDM so you can email them from here and from ${l.name} deals.`));
}

function contactDialog({ lenderId, existing = null }) {
  formModal(existing ? `Edit ${existing.name}` : 'New lender contact', [
    { name: 'name', label: 'Name', required: true },
    { name: 'role', label: 'Role', type: 'select', required: true, default: 'bdm', options: Object.entries(ROLE_LABELS) },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'mobile', label: 'Mobile' },
    { name: 'phone', label: 'Office phone' },
    { name: 'region', label: 'Region / state (e.g. NSW & ACT)' },
    { name: 'is_primary', label: 'Main contact for this lender (shown on the Lenders list)', type: 'checkbox', full: true, default: !existing },
    { name: 'notes', label: 'Notes (e.g. best time to call, assistant\'s name)', type: 'textarea', rows: 2, full: true },
  ], existing ? { ...existing, is_primary: existing.is_primary ? 1 : 0 } : {}, async (v) => {
    await attempt(() => api(existing ? `/lenders/contacts/${existing.id}` : `/lenders/${lenderId}/contacts`, { method: existing ? 'PATCH' : 'POST', body: v }), 'Saved');
    refresh();
  });
}

function lenderEmailsCard(l) {
  return h('section.card',
    h('div.card-head', h('h2', 'Emails'), h('button.small', { type: 'button', onclick: () => emailLenderDialog({ lenderId: l.id, lender: l }) }, '+ New email')),
    mailList(l.emails, { empty: `No emails with ${l.name} yet. Emails to and from your contacts here are filed automatically when Outlook is connected.`, showClient: true }),
    l.outbox.length ? h('details.outbox-details',
      h('summary.muted.small', `Sent without Outlook (${l.outbox.length})`),
      h('ul.plain', l.outbox.map((e) => h('li.small', e.subject, ' ', badge(e.status, { failed: 'danger', queued: 'warn', sent: 'ok', logged: 'info' }[e.status]),
        h('div.muted', `To ${e.to_email} · ${dateTime(e.sent_at || e.send_after)}`, e.contact_id ? [' · about ', h('a', { href: `#/contacts/${e.contact_id}` }, e.contact_name)] : null))))) : null);
}

// ---- Emailing someone at a lender ---------------------------------------------------------

// Plain-text summary of a deal, the facts a BDM usually asks for.
function dealSummary(d, client) {
  const lvr = d.loan_amount && d.property_value ? Math.round((d.loan_amount / d.property_value) * 1000) / 10 : null;
  return [
    `Client: ${client}${d.co_borrower_name ? ` & ${d.co_borrower_name.trim()}` : ''}`,
    d.application_ref ? `Application ref: ${d.application_ref}` : null,
    `Loan purpose: ${label(d.loan_purpose || '')}`,
    d.loan_amount ? `Loan amount: ${money(d.loan_amount)}` : null,
    d.property_value ? `Property value: ${money(d.property_value)}${lvr ? ` (LVR ${lvr}%)` : ''}` : null,
    d.property_address ? `Security: ${d.property_address}` : null,
    d.product_name ? `Product: ${d.product_name}${d.interest_rate ? ` at ${pct(d.interest_rate)}` : ''}` : null,
    `Stage: ${stageLabel(d.stage)}`,
    d.finance_due_date ? `Finance due: ${date(d.finance_due_date)}` : null,
    d.settlement_date ? `Settlement: ${date(d.settlement_date)}` : null,
  ].filter(Boolean).join('\n');
}

// Email a BDM (or anyone at the lender). Optionally about a client and deal,
// in which case it's filed on the client's timeline and replies follow it.
export async function emailLenderDialog({ lenderId, lender = null, contactId = null, dealId = null, to = null }) {
  const [l, status] = await Promise.all([lender?.contacts ? lender : api(`/lenders/${lenderId}`), api('/outlook/status')]);
  const clients = new Map(); // shown name → contact, filled as you type
  const withEmail = l.contacts.filter((c) => c.email);
  const toSelect = h('select', { name: 'to_pick', 'aria-label': 'To' },
    withEmail.map((c) => h('option', { value: c.email, selected: to ? c.email === to : c.is_primary }, `${c.name} – ${c.role_label} <${c.email}>`)),
    h('option', { value: '', selected: !withEmail.length }, 'Another address…'));
  const toOther = h('input', { type: 'text', name: 'to_other', placeholder: 'name@lender.com.au', 'aria-label': 'Email address' });
  const syncTo = () => { toOther.hidden = Boolean(toSelect.value); };
  toSelect.addEventListener('change', syncTo);

  // Client picker: type a name, pick from the list.
  const listId = `clients_${Math.random().toString(36).slice(2, 7)}`;
  const nameOf = (c) => `${fullName(c)}${c.email ? ` (${c.email})` : ''}`;
  const clientInput = h('input', { type: 'search', list: listId, placeholder: 'Start typing a client\'s name…', 'aria-label': 'Client' });
  const datalist = h('datalist', { id: listId });
  let lookup = 0;
  clientInput.addEventListener('input', () => {
    const q = clientInput.value.trim();
    if (q.length < 2 || clients.has(q)) return;
    const n = ++lookup;
    setTimeout(async () => {
      if (n !== lookup) return;
      const { rows } = await api(`/contacts?limit=20&q=${encodeURIComponent(q)}`);
      if (n !== lookup) return;
      for (const c of rows) clients.set(nameOf(c), c);
      datalist.replaceChildren(...rows.map((c) => h('option', { value: nameOf(c) })));
    }, 200);
  });
  const dealSelect = h('select', { 'aria-label': 'Deal', hidden: true });
  const summaryBtn = h('button.secondary.small', { type: 'button', hidden: true }, '+ Insert deal summary');
  const filedNote = h('p.muted.small');
  let client = null;
  let deals = [];

  const subject = h('input', { type: 'text', required: true, 'aria-label': 'Subject' });
  const body = h('textarea', { rows: 12, required: true, 'aria-label': 'Message' });
  const firstName = () => (l.contacts.find((c) => c.email === (toSelect.value || toOther.value.trim()))?.name || '').split(' ')[0];
  body.value = `Hi ${firstName() || 'there'},\n\n\n\nKind regards,`;
  toSelect.addEventListener('change', () => {
    body.value = body.value.replace(/^Hi [^,\n]*,/, `Hi ${firstName() || 'there'},`);
  });

  const describe = () => {
    filedNote.textContent = client
      ? `This email, and ${l.name}'s replies, will be filed on ${fullName(client)}'s timeline${dealSelect.value ? ' and deal' : ''}, and on this lender.`
      : `Saved on ${l.name}'s page. Pick a client if it's about one, so it's filed on their timeline too.`;
  };
  const chooseClient = async (c) => {
    client = c;
    deals = [];
    dealSelect.hidden = true;
    summaryBtn.hidden = true;
    if (c) {
      deals = c.deals || (await api(`/contacts/${c.id}`)).deals;
      dealSelect.replaceChildren(h('option', { value: '' }, 'Not about a particular deal'),
        ...deals.map((d) => h('option', { value: d.id }, `${d.title} – ${stageLabel(d.stage)}${d.lender_name ? ` (${d.lender_name})` : ''}`)));
      const best = deals.find((d) => d.id === Number(dealId)) || deals.find((d) => d.lender_id === l.id && !['settled', 'lost'].includes(d.stage)) || deals.find((d) => d.lender_id === l.id);
      dealSelect.value = best ? String(best.id) : '';
      dealSelect.hidden = !deals.length;
      summaryBtn.hidden = !deals.length;
      if (!subject.value) {
        const d = deals.find((x) => x.id === Number(dealSelect.value));
        subject.value = `${fullName(c)}${d?.application_ref ? ` – ${d.application_ref}` : ''}`;
      }
    }
    describe();
  };
  clientInput.addEventListener('change', () => {
    const c = clients.get(clientInput.value) || null;
    if (!c && clientInput.value) toast('Pick the client from the list', 'error');
    chooseClient(c);
  });
  dealSelect.addEventListener('change', describe);
  summaryBtn.addEventListener('click', () => {
    const d = deals.find((x) => x.id === Number(dealSelect.value));
    if (!d) return toast('Choose a deal first', 'error');
    const text = dealSummary(d, fullName(client));
    const { selectionStart: start } = body;
    const at = body.value.indexOf('\n\n\n') >= 0 && start === body.value.length ? body.value.indexOf('\n\n\n') + 2 : start;
    body.value = `${body.value.slice(0, at)}${text}\n${body.value.slice(at)}`;
    body.focus();
  });

  const send = h('button', { type: 'submit' }, 'Send');
  const form = h('form.lender-email',
    h('div.field', h('label', 'To'), toSelect, toOther),
    h('div.field', h('label', 'About a client (optional)'), clientInput, datalist, dealSelect),
    filedNote,
    h('div.field', h('label', 'Subject'), subject),
    h('div.field', h('div.label-row', h('label', 'Message'), summaryBtn), body),
    status.account?.connected
      ? h('p.muted.small', `Sends from your Outlook (${status.account.email}) with your signature.`)
      : h('p.small.text-warn', 'Your Outlook isn\'t connected, so this will only be logged, not sent. Connect it in Settings.'),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), send));
  const d = modal(`Email ${l.name}`, form, { wide: true });
  syncTo();
  describe();
  if (contactId) {
    const c = await api(`/contacts/${contactId}`);
    clients.set(nameOf(c), c);
    clientInput.value = nameOf(c);
    await chooseClient(c);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const address = toSelect.value || toOther.value.trim();
    if (!address) return toast('Enter who to send it to', 'error');
    send.disabled = true;
    try {
      const r = await attempt(() => api('/outbox', {
        method: 'POST',
        body: {
          to_email: address, subject: subject.value, body: body.value, lender_id: l.id,
          contact_id: client?.id ?? null, deal_id: client && dealSelect.value ? Number(dealSelect.value) : null,
        },
      }));
      if (r.status === 'failed') toast(`Not sent: ${r.error}`, 'error');
      else toast(r.sent_via === 'outlook' ? 'Sent from Outlook' : r.status === 'sent' ? 'Sent' : 'Logged (email not connected)');
      d.close();
      refresh();
    } catch { /* shown */ } finally {
      send.disabled = false;
    }
  });
}
