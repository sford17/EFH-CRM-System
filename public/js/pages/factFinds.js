// Online fact finds and document requests: sending them, the list, and
// reviewing what the client sent (answers, documents, import into the CRM).
import { api, h, pageHeader, attempt, toast, confirmDialog, modal, badge, dateTime, date, fullName, table } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const STATUS = {
  sent: ['sent', 'info'], in_progress: ['in progress', 'info'], submitted: ['to review', 'warn'], reviewed: ['done', 'ok'], cancelled: ['cancelled', ''],
};
const statusBadge = (r) => (r.expired && ['sent', 'in_progress'].includes(r.status) ? badge('expired', 'danger') : badge(...(STATUS[r.status] || [r.status, ''])));
const kindLabel = (k) => (k === 'documents' ? 'Document request' : 'Fact find');
const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast('Link copied'), () => toast('Couldn\'t copy – select the link and copy it', 'error'));

function reachWarning(r) {
  if (r.public) return null;
  return h('div.alert.warn-box.small', h('strong', 'Clients can\'t open links to this computer yet. '),
    `Links point to ${r.base}, which only works here. Put the CRM online (see the README, "Putting the CRM online for clients") and set its web address in Settings → Business, then send the link.`);
}

// ---- Sending ------------------------------------------------------------------------------------

export async function sendFactFindDialog({ contact, dealId = null, kind = 'full' }) {
  const [lib, c] = await Promise.all([api('/fact-finds/library'), api(`/contacts/${contact.id}`)]);
  let mode = kind;
  const body = h('div');
  const d = modal(`Send ${contact.first_name} a fact find`, body, { wide: true });
  const draw = () => {
    const to = h('input', { type: 'email', value: c.email || '', required: true, 'aria-label': 'Send to' });
    const deal = h('select', { 'aria-label': 'Deal' }, h('option', { value: '' }, 'No deal'),
      c.deals.map((x) => h('option', { value: x.id, selected: Number(dealId) === x.id }, x.title)));
    const message = h('textarea', { rows: 4, placeholder: mode === 'full' ? 'Leave blank for the standard message: "To get things moving, I need some details about you, your finances and what you\'d like to achieve, plus a few documents…"' : 'Leave blank for: "Could you please upload the documents below? You can take photos with your phone or upload files from your computer."' });
    const days = h('select', { 'aria-label': 'Link works for' }, [14, 30, 60, 90].map((n) => h('option', { value: n, selected: n === 30 }, `${n} days`)));
    const partner = c.household?.length > 1 ? h('input', { type: 'checkbox', checked: true }) : null;
    const checks = lib.documents.map(([label]) => h('label.ff-pick', h('input', { type: 'checkbox', value: label }), h('span', label)));
    const custom = h('textarea', { rows: 3, placeholder: 'Anything else, one per line (e.g. "Letter from your employer confirming your return-to-work date")' });
    const send = async (emailIt) => {
      const requests = mode === 'documents'
        ? [...checks.map((x) => x.querySelector('input')).filter((x) => x.checked).map((x) => x.value), ...custom.value.split('\n').map((x) => x.trim()).filter(Boolean)]
        : null;
      if (mode === 'documents' && !requests.length) { toast('Tick at least one document', 'error'); return; }
      const btns = body.querySelectorAll('.actions button');
      btns.forEach((b) => { b.disabled = true; });
      try {
        const r = await api('/fact-finds', {
          method: 'POST',
          body: { contact_id: contact.id, deal_id: deal.value ? Number(deal.value) : null, kind: mode, requests, message: message.value, to: to.value, expires_days: Number(days.value), include_partner: partner ? partner.checked : true, send: emailIt },
        });
        d.close();
        toast(emailIt ? `Sent to ${r.sent_to}` : 'Link created – copy it from the next page');
        location.hash = `#/fact-finds/${r.id}`;
      } catch (err) {
        toast(err.message, 'error');
        btns.forEach((b) => { b.disabled = false; });
      }
    };
    body.replaceChildren(
      h('div.ffb-seg', { role: 'group', 'aria-label': 'What to send' },
        [['full', '📝 Full fact find'], ['documents', '📎 Request documents only']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(mode === k), onclick: () => { mode = k; draw(); } }, l))),
      h('p.small.muted', mode === 'full'
        ? 'A branded online fact find with your logo and colours. Questions adapt to their answers (partner, employment, plans, what they own and owe, living expenses), and it asks for the documents that apply to them. It\'s pre-filled with what the CRM already knows.'
        : 'Just a branded upload page for the documents you choose – for clients whose details you already have.'),
      reachWarning(lib.reachability),
      h('div.grid-form',
        h('label.field', h('span', 'Send to'), to),
        h('label.field', h('span', 'Deal'), deal),
        mode === 'full' && partner ? h('label.field.full.check', partner, h('span', `Include ${c.household.filter((m) => m.id !== contact.id).map((m) => m.first_name).join(', ')} (household) as the second applicant`)) : null,
        mode === 'documents' ? h('div.field.full', h('span', 'Documents to request'), h('div.ff-picks', checks)) : null,
        mode === 'documents' ? h('label.field.full', h('span', 'Other documents'), custom) : null,
        h('label.field.full', h('span', 'Message (optional)'), message),
        h('label.field', h('span', 'Link works for'), days)),
      h('div.actions',
        h('button.secondary', { type: 'button', onclick: () => send(false) }, 'Just create the link'),
        h('button', { type: 'button', onclick: () => send(true) }, 'Email it to the client')));
  };
  draw();
}

// ---- Card on the contact page ----------------------------------------------------------------------

export async function factFindsCard(contact) {
  const { rows } = await api(`/fact-finds?contact_id=${contact.id}`);
  return h('section.card',
    h('div.card-head', h('h2', 'Fact finds & documents'),
      h('div.actions',
        h('button.small', { type: 'button', onclick: () => sendFactFindDialog({ contact, kind: 'full' }) }, '📝 Fact find'),
        h('button.small.secondary', { type: 'button', onclick: () => sendFactFindDialog({ contact, kind: 'documents' }) }, '📎 Documents'))),
    rows.length ? h('ul.plain', rows.slice(0, 6).map((r) => h('li',
      h('a', { href: `#/fact-finds/${r.id}` }, kindLabel(r.kind)), ' ', statusBadge(r),
      h('div.muted.small', [`Sent ${date(r.created_at)}`, r.documents ? `${r.documents_received}/${r.documents} documents` : null, r.kind === 'full' && r.progress !== null && r.progress < 100 ? `${r.progress}% done` : null].filter(Boolean).join(' · ')))))
      : h('p.empty.small', 'Send an online fact find, or ask for documents.'));
}

// ---- List page ---------------------------------------------------------------------------------------

const FILTERS = [['open', 'Waiting on client'], ['submitted', 'To review'], ['reviewed', 'Done'], ['', 'All']];
let filter = 'submitted';
export async function factFindsPage() {
  const data = await api(`/fact-finds?status=${filter}`);
  const counts = await api('/fact-finds?status=submitted');
  return h('div',
    pageHeader('Fact finds'),
    h('p.muted', 'Online fact finds and document requests you\'ve sent. Send one from a client\'s page (📝 Fact find or 📎 Documents) or from a deal.'),
    reachWarning(data.reachability),
    h('div.ffb-seg', { role: 'group', 'aria-label': 'Show' }, FILTERS.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; refresh(); } },
      l, k === 'submitted' && counts.rows.length ? ` (${counts.rows.length})` : ''))),
    h('section.card', table([
      { label: 'Client', value: (r) => [h('a', { href: `#/fact-finds/${r.id}` }, r.name), r.deal_title ? h('div.small.muted', r.deal_title) : null] },
      { label: 'Type', value: (r) => kindLabel(r.kind) },
      { label: 'Status', value: statusBadge },
      { label: 'Progress', value: (r) => (r.kind === 'full' ? `${r.progress}%` : '–') },
      { label: 'Documents', value: (r) => (r.documents ? `${r.documents_received} of ${r.documents}` : '–') },
      { label: 'Sent', value: (r) => date(r.created_at) },
      { label: 'Last activity', value: (r) => (r.submitted_at ? `Completed ${dateTime(r.submitted_at)}` : r.last_saved_at ? `Saved ${dateTime(r.last_saved_at)}` : r.opened_at ? `Opened ${dateTime(r.opened_at)}` : 'Not opened yet') },
    ], data.rows, { onRow: (r) => { location.hash = `#/fact-finds/${r.id}`; }, empty: filter === 'submitted' ? 'Nothing to review right now.' : 'None here.' })));
}

// ---- Review page -------------------------------------------------------------------------------------

function fileLink(f) {
  return h('div.ff-filerow',
    h('a', { href: `/api/fact-finds/files/${f.id}`, target: '_blank', rel: 'noopener noreferrer' }, `📎 ${f.filename}`),
    h('span.small.muted', ` ${f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`} · ${dateTime(f.created_at)} `),
    h('a.small', { href: `/api/fact-finds/files/${f.id}?download=1` }, 'Download'));
}

export async function factFindPage(id) {
  const r = await api(`/fact-finds/${id}`);
  const post = async (path, body = {}, msg) => {
    try {
      const res = await attempt(() => api(`/fact-finds/${id}/${path}`, { method: 'POST', body }), msg);
      refresh();
      return res;
    } catch { return null; }
  };
  const importIt = async () => {
    const again = Boolean(r.imported_at);
    if (!(await confirmDialog(again
      ? 'Import the answers again? This updates the same contacts, properties, loans and assets it created last time.'
      : `Import ${r.contact.first_name}'s answers into the CRM? This updates their contact details${r.answers?.applicants.length > 1 ? ', adds or updates their partner' : ''}, saves properties, debts and assets to the mortgage tracker${r.deal ? ', and updates the deal' : ''}.`))) return;
    const res = await post('import', {}, 'Imported into the CRM');
    if (res) modal('Imported', h('ul', res.done.map((x) => h('li', x))));
  };
  const remove = async () => {
    if (!(await confirmDialog('Delete this, including the uploaded files? The link will stop working.'))) return;
    try {
      await attempt(() => api(`/fact-finds/${id}`, { method: 'DELETE' }), 'Deleted');
      location.hash = '#/fact-finds';
    } catch { /* toasted */ }
  };
  const open = ['sent', 'in_progress'].includes(r.status);
  const docsNeeded = r.documents.filter((d) => !d.optional);
  const received = docsNeeded.filter((d) => d.files.length).length;
  const facts = [
    ['Sent', `${dateTime(r.created_at)}${r.sent_to ? ` to ${r.sent_to}` : ' (link only)'}`],
    ['Opened', r.opened_at ? dateTime(r.opened_at) : 'Not yet'],
    r.kind === 'full' ? ['Last saved', r.last_saved_at ? dateTime(r.last_saved_at) : '–'] : null,
    ['Completed', r.submitted_at ? dateTime(r.submitted_at) : '–'],
    r.reminders ? ['Reminders', `${r.reminders} (last ${dateTime(r.reminded_at)})`] : null,
    ['Link works until', `${date(r.expires_at)}${r.expired ? ' (expired)' : ''}`],
    r.imported_at ? ['Imported', dateTime(r.imported_at)] : null,
  ].filter(Boolean);

  return h('div',
    pageHeader(`${kindLabel(r.kind)} – ${fullName(r.contact)}`,
      h('a.button.secondary', { href: `#/contacts/${r.contact.id}` }, 'Client'),
      r.deal ? h('a.button.secondary', { href: `#/deals/${r.deal.id}` }, 'Deal') : null),
    reachWarning(r.reachability),
    r.status === 'submitted' && r.kind === 'full' && !r.imported_at ? h('div.alert.info', h('strong', `${r.contact.first_name} has completed the fact find. `), 'Check the answers and documents, then import them into the CRM.') : null,
    h('div.detail-grid',
      h('div.col-side',
        h('section.card',
          h('div.card-head', h('h2', 'Status'), statusBadge(r)),
          h('dl.info', facts.map(([k, v]) => h('div.info-row', h('dt', k), h('dd', v)))),
          h('div.ff-link', h('input', { type: 'text', readonly: true, value: r.link, 'aria-label': 'Client\'s link', onfocus: (e) => e.target.select() }),
            h('button.small.secondary', { type: 'button', onclick: () => copy(r.link) }, 'Copy')),
          h('div.actions.ffb-actions',
            r.kind === 'full' && ['submitted', 'reviewed'].includes(r.status) ? h('button', { type: 'button', onclick: importIt }, r.imported_at ? 'Import again' : 'Import into CRM') : null,
            r.kind === 'full' ? h('a.button.secondary', { href: `/api/fact-finds/${id}/pdf` }, 'Download PDF') : null,
            open && !r.expired ? h('button.secondary', { type: 'button', onclick: () => post('remind', {}, 'Reminder sent') }, 'Send a reminder') : null,
            r.status === 'sent' && !r.sent_to ? h('button.secondary', { type: 'button', onclick: () => post('send', {}, 'Emailed') }, 'Email the link') : null,
            r.expired || r.status === 'cancelled' ? h('button.secondary', { type: 'button', onclick: () => post('extend', { days: 30 }, 'Link works for another 30 days') }, 'Extend 30 days') : null,
            r.kind === 'full' && r.status === 'submitted' ? h('button.secondary', { type: 'button', onclick: () => post('reopen', {}, 'Reopened – the client can make changes') }, 'Let them make changes') : null,
            r.kind === 'documents' && r.status !== 'reviewed' ? h('button.secondary', { type: 'button', onclick: () => post('reviewed', {}, 'Marked as done') }, 'Mark as done') : null,
            r.status !== 'cancelled' && r.status !== 'reviewed' ? h('button.link.small', { type: 'button', onclick: () => post('cancel', {}, 'Cancelled') }, 'Cancel link') : null,
            h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete'))),
        r.import_result ? h('section.card', h('h2', 'Last import'), h('ul.small', r.import_result.done.map((x) => h('li', x)))) : null,
        h('section.card',
          h('div.card-head', h('h2', `Documents (${received}/${docsNeeded.length})`)),
          h('div.meter', h('div.meter-fill', { style: { width: `${docsNeeded.length ? (received / docsNeeded.length) * 100 : 0}%` } })),
          h('ul.ff-docs', r.documents.map((d) => h(`li${d.files.length ? '.got' : ''}`,
            h('div', h('span', d.files.length ? '✅ ' : d.optional ? '➕ ' : '⏳ '), d.label, d.who ? h('span.muted.small', ` – ${d.who}`) : null),
            d.files.map(fileLink)))),
          r.other_files.length ? [h('h3', 'Other files'), r.other_files.map(fileLink)] : null)),
      h('div.col-main',
        r.kind === 'documents'
          ? h('section.card', h('h2', 'Message sent'), h('p.pre', r.message))
          : !r.summary || (r.status === 'sent' && !r.last_saved_at)
            ? h('section.card', h('h2', 'Answers'), h('p.empty', 'The client hasn\'t started yet. What the CRM already knew has been filled in for them.'))
            : [
              r.status !== 'submitted' && r.status !== 'reviewed' ? h('div.alert.info.small', 'Still in progress – these are the answers so far.') : null,
              r.summary.map((s) => h('section.card.ff-answers', h('h2', s.title),
                s.groups.map((g) => [h('h3', g.heading), g.rows.length ? h('dl.info', g.rows.map(([k, v]) => h('div.info-row', h('dt', k), h('dd', v)))) : null]))),
              r.answers.declaration?.signature ? h('p.small.muted', `Declaration agreed and signed "${r.answers.declaration.signature}"${r.submitted_at ? ` on ${date(r.submitted_at)}` : ''}.`) : null,
            ])));
}
