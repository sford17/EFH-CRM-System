// Asking a client for a Google review, one-off, by email and/or SMS.
import { api, h, attempt, modal, toast, date, fullName, state } from '../core.js';
import { counted } from './sms.js';
import { previewEmail } from './branding.js';
import { bodyPreview } from './graphics.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

export async function requestReviewDialog({ contact, dealId = null }) {
  const d = await api(`/contacts/${contact.id}/review-request`);
  const name = contact.first_name;
  if (!d.link) {
    const box = modal('Request a Google review', [
      h('p', 'First, add your Google review link so clients can go straight to the review form.'),
      h('ol.small',
        h('li', 'Open your Google Business Profile (search your business name on Google while signed in, or go to business.google.com).'),
        h('li', 'Click "Ask for reviews" (or "Get more reviews") and copy the link, e.g. https://g.page/r/…/review.'),
        h('li', 'Paste it into Settings → Business → Google review link.')),
      h('div.actions',
        state.user.role === 'admin' ? h('a.button', { href: '#/settings', onclick: () => box.close() }, 'Go to Settings') : h('span.muted.small', 'Ask an admin to add it in Settings.')),
    ]);
    return;
  }

  const notes = [
    d.google_reviewed_at ? h('div.alert.info', `${name} already left a Google review (marked ${date(d.google_reviewed_at)}).`) : null,
    d.review_requested_at ? h(`div.alert${d.days_since_asked < 90 ? '.warn-box' : '.info'}`, `Last asked ${date(d.review_requested_at)}${d.days_since_asked === 0 ? ' (today)' : d.days_since_asked === 1 ? ' (yesterday)' : d.days_since_asked ? ` (${d.days_since_asked} days ago)` : ''}.${d.days_since_asked < 90 ? ' Asking again so soon may feel pushy.' : ''}`) : null,
  ];

  const useEmail = h('input', { type: 'checkbox', checked: !d.email_blocked, disabled: Boolean(d.email_blocked) });
  const useSms = h('input', { type: 'checkbox', checked: !d.sms_blocked && Boolean(d.sms), disabled: Boolean(d.sms_blocked) });
  const subject = h('input', { type: 'text', value: d.subject, 'aria-label': 'Email subject' });
  const body = h('textarea', { rows: 10, 'aria-label': 'Email message' }, d.body);
  const smsText = h('textarea', { rows: 3, 'aria-label': 'SMS message' }, d.sms);
  const chips = h('div.small');
  const showChips = () => chips.replaceChildren(bodyPreview(body.value));
  body.addEventListener('input', showChips);
  showChips();

  const emailBox = h('fieldset.review-part',
    h('legend', h('label.check-inline', useEmail, ` Email ${d.email_to || ''}`)),
    d.email_blocked ? h('p.muted.small', d.email_blocked) : [
      h('div.field', h('label', 'Subject'), subject),
      h('div.field', h('label', 'Message'), body),
      h('details.small', h('summary.muted', 'How it will look'), chips),
      h('div', h('button.secondary.small', { type: 'button', onclick: () => previewEmail({ subject: subject.value, body: body.value, contact_id: contact.id }) }, 'Preview email')),
    ]);
  const smsBox = h('fieldset.review-part',
    h('legend', h('label.check-inline', useSms, ` SMS ${d.mobile || ''}`)),
    d.sms_blocked ? h('p.muted.small', d.sms_blocked) : [
      h('div.field', h('label', 'Text message (an opt-out line is added, as it\'s a marketing message)'), smsText, counted(smsText)),
    ]);

  const send = h('button', { type: 'button' }, 'Send request');
  const dlg = modal(`Request a Google review – ${fullName(contact)}`, [
    ...notes.filter(Boolean),
    h('p.muted.small', ['Your review link: ', h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer' }, d.link)]),
    emailBox, smsBox,
    d.email_blocked && d.sms_blocked ? h('p.text-danger', `${name} can't be sent a review request.`) : null,
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), send),
  ], { wide: true });

  send.addEventListener('click', async () => {
    const payload = {
      deal_id: dealId || undefined,
      email: useEmail.checked ? { subject: subject.value, body: body.value } : null,
      sms: useSms.checked ? { body: smsText.value } : null,
    };
    if (!payload.email && !payload.sms) return toast('Tick email, SMS or both', 'error');
    send.disabled = true;
    try {
      const r = await attempt(() => api(`/contacts/${contact.id}/review-request`, { method: 'POST', body: payload }));
      toast(`Review request sent by ${r.sent.join(' and ')}`);
      dlg.close();
      refresh();
    } catch { /* shown */ } finally {
      send.disabled = false;
    }
  });
}

// "Google review" line on a contact: status plus actions.
export function googleReviewInfo(c) {
  const mark = async (reviewed) => {
    await attempt(() => api(`/contacts/${c.id}/google-review`, { method: 'PUT', body: { reviewed } }), reviewed ? 'Marked as reviewed' : 'Updated');
    refresh();
  };
  return h('div.google-review',
    h('div', c.google_reviewed_at ? h('span', '⭐ Left a review ', h('span.muted.small', date(c.google_reviewed_at)))
      : c.review_requested_at ? h('span', 'Asked ', date(c.review_requested_at)) : h('span.muted', 'Not asked yet')),
    h('div.row-actions',
      h('button.link.small', { type: 'button', onclick: () => requestReviewDialog({ contact: c }) }, 'Request review'),
      c.google_reviewed_at
        ? h('button.link.small', { type: 'button', onclick: () => mark(false) }, 'Undo')
        : h('button.link.small', { type: 'button', onclick: () => mark(true) }, 'Mark as reviewed')));
}
