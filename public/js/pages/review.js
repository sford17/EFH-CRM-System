// Client Lending Review editor: commentary on the left, live document preview
// on the right; download as PDF / Word or email to the client.
import { api, h, attempt, modal, confirmDialog, toast, date, dateTime, badge, field, readForm, pageHeader } from '../core.js';
import { addresseePicker } from './household.js';

const SECTIONS = [
  ['loan_review', 'Loan review', 'A summary of where the client\'s lending stands today.'],
  ['actions_to_consider', 'Actions to consider', 'Options for the client to think about.'],
  ['broker_to_action', 'Broker to action', 'What you will do next. Shown to the client as "What we\'ll do".'],
  ['next_steps', 'Next steps', 'How and when you\'ll follow up.'],
];

export async function startReview(contactId) {
  const r = await attempt(() => api('/reviews', { method: 'POST', body: { contact_id: contactId } }));
  location.hash = `#/reviews/${r.id}`;
}

export function reviewsCard(contactId, rows) {
  return h('section.card',
    h('div.card-head', h('h2', 'Lending reviews'), h('button.small', { type: 'button', onclick: () => startReview(contactId) }, '+ New review')),
    rows.length
      ? h('ul.plain', rows.map((r) => h('li', h('a', { href: `#/reviews/${r.id}` }, `${r.title} – ${date(r.review_date)}`), ' ',
        badge(r.status === 'sent' ? 'sent' : 'draft', r.status === 'sent' ? 'ok' : 'warn'),
        h('div.muted.small', r.status === 'sent' ? `Emailed to ${r.sent_to} ${dateTime(r.sent_at)}` : `Last edited ${dateTime(r.updated_at)}`))))
      : h('p.empty', 'No reviews yet. A review pulls in everything from the mortgage tracker for you to comment on.'));
}

export async function reviewPage(id) {
  let r = await api(`/reviews/${id}`);
  const frame = h('iframe.review-frame', { src: `/api/reviews/${id}/preview`, sandbox: 'allow-same-origin', title: 'Review preview' });
  const status = h('span.muted.small.save-state', 'All changes saved');
  const reload = () => { frame.src = `/api/reviews/${id}/preview?t=${Date.now()}`; };

  let timer;
  const save = (patch) => {
    status.textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        r = { ...r, ...(await api(`/reviews/${id}`, { method: 'PATCH', body: patch() })) };
        status.textContent = 'All changes saved';
        reload();
      } catch (err) {
        status.textContent = 'Not saved';
        toast(err.message, 'error');
      }
    }, 700);
  };

  const meta = [
    { name: 'title', label: 'Document title', required: true },
    { name: 'review_date', label: 'Review date', type: 'date', required: true },
  ];
  const metaForm = h('form.grid-form', { onsubmit: (e) => e.preventDefault() }, meta.map((f) => field(f, r[f.name])));
  const areas = {};
  const editors = SECTIONS.map(([key, title, hint]) => {
    const ta = h('textarea', { rows: key === 'loan_review' || key === 'actions_to_consider' ? 9 : 5, 'aria-label': title }, r[key] || '');
    areas[key] = ta;
    const useSuggestion = async () => {
      if (ta.value.trim() && !(await confirmDialog(`Replace the ${title.toLowerCase()} text with the suggested wording?`))) return;
      ta.value = r.suggestions[key];
      ta.dispatchEvent(new Event('input'));
    };
    return h('div.review-section',
      h('div.review-section-head', h('h3', title), h('button.link.small', { type: 'button', onclick: useSuggestion }, 'Use suggested text')),
      h('div.muted.small', hint, ' Start lines with "-" or "•" for bullet points.'),
      ta);
  });
  // Address the document to one or both of a couple.
  const picker = addresseePicker(r.household, r.addressees.map((a) => a.id), async (ids) => {
    try {
      r = { ...r, ...(await api(`/reviews/${id}`, { method: 'PATCH', body: { addressee_ids: ids } })) };
      r.addressees = r.household.filter((m) => ids.includes(m.id));
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });
  const collect = () => ({ ...readForm(metaForm, meta), ...Object.fromEntries(Object.entries(areas).map(([k, ta]) => [k, ta.value])) });
  for (const el of [...metaForm.querySelectorAll('input'), ...Object.values(areas)]) el.addEventListener('input', () => save(collect));

  const refreshFigures = async () => {
    await attempt(() => api(`/reviews/${id}/refresh`, { method: 'POST', body: {} }), 'Figures updated from the mortgage tracker');
    r = await api(`/reviews/${id}`);
    reload();
  };
  const remove = async () => {
    if (!(await confirmDialog('Delete this review?'))) return;
    await attempt(() => api(`/reviews/${id}`, { method: 'DELETE' }), 'Review deleted');
    location.hash = `#/contacts/${r.contact_id}`;
  };
  const emailIt = () => {
    const fields = [
      { name: 'to', label: 'To (separate several addresses with commas)', required: true, full: true },
      { name: 'subject', label: 'Subject', required: true, full: true },
      { name: 'body', label: 'Message', type: 'textarea', rows: 9, required: true, full: true },
    ];
    const people = r.addressees.length ? r.addressees : [r.contact];
    const firsts = people.map((p) => p.first_name);
    const first = firsts.length > 1 ? `${firsts.slice(0, -1).join(', ')} and ${firsts[firsts.length - 1]}` : firsts[0];
    const form = h('form.grid-form', fields.map((f) => field(f, {
      to: people.map((p) => p.email).filter(Boolean).join(', '),
      subject: `Your ${r.title} – ${date(r.review_date)}`,
      body: `Hi ${first},\n\nPlease find attached your ${r.title.toLowerCase()}. It summarises your current loans and properties, along with a few things worth considering and what I'll be doing next.\n\nHappy to talk through any of it – just reply or give me a call.\n\nKind regards,`,
    }[f.name])), h('p.muted.small.full', '📎 The review is attached as a PDF. Your email signature is added automatically.'),
    h('div.actions.full', h('button', { type: 'submit' }, 'Send')));
    const d = modal('Email review to client', form, { wide: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await attempt(() => api(`/reviews/${id}/email`, { method: 'POST', body: readForm(form, fields) }));
        toast(res.sent_via === 'outlook' ? 'Review emailed from your Outlook' : res.status === 'sent' ? 'Review emailed' : 'Logged – connect Outlook to send for real');
        d.close();
        window.dispatchEvent(new Event('crm:refresh'));
      } catch { /* shown */ } finally {
        btn.disabled = false;
      }
    });
  };

  return h('div',
    pageHeader(h('span', r.title, ' ', badge(r.status === 'sent' ? 'sent' : 'draft', r.status === 'sent' ? 'ok' : 'warn')),
      h('a.button.secondary', { href: `#/contacts/${r.contact_id}?tab=tracker` }, `← ${r.contact.full_name}`),
      h('a.button.secondary', { href: `/api/reviews/${id}/docx`, download: '' }, 'Word'),
      h('a.button.secondary', { href: `/api/reviews/${id}/pdf`, download: '' }, 'PDF'),
      h('button', { type: 'button', onclick: emailIt }, 'Email to client')),
    h('p.muted', `For ${r.prepared_for || r.contact.full_name}. Figures as at ${dateTime(r.snapshot_taken_at)} `,
      h('button.link', { type: 'button', onclick: refreshFigures }, '(refresh from the mortgage tracker)'),
      r.status === 'sent' ? ` · emailed to ${r.sent_to} ${dateTime(r.sent_at)}` : ''),
    h('div.review-layout',
      h('div.review-editor',
        h('section.card', metaForm, picker, h('div.review-status', status)),
        h('section.card', editors),
        h('div.actions', h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete review'))),
      h('div.review-preview', frame)));
}
