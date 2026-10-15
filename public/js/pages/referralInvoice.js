// Ask a referral partner for a tax invoice for their referral fee, once the loan settles.
import { api, h, modal, attempt, toast, dateTime, money2 } from '../core.js';

export async function referralInvoiceDialog(dealId, onSent) {
  let d0;
  try {
    d0 = await attempt(() => api(`/deals/${dealId}/referral-invoice`));
  } catch { return; }
  const to = h('input', { type: 'email', value: d0.to, required: true, 'aria-label': 'To' });
  const fee = h('input', { type: 'number', min: 0, step: '0.01', value: d0.figures.fee_ex_gst, 'aria-label': 'Referral fee before GST' });
  const subject = h('input', { value: d0.subject, required: true, 'aria-label': 'Subject' });
  const body = h('textarea', { rows: 16, required: true, 'aria-label': 'Message' }, d0.body);
  const sums = h('div.ri-sums');
  const showSums = (f) => sums.replaceChildren(
    h('div', h('span', 'Referral fee'), h('strong', money2(f.fee_ex_gst))),
    h('div', h('span', f.gst_registered ? 'GST (10%)' : 'GST'), h('strong', f.gst_registered ? money2(f.gst) : 'not registered')),
    h('div.total', h('span', 'Total including GST'), h('strong', money2(f.fee_inc_gst))));
  showSums(d0.figures);
  // A changed fee redoes the figures in the message (anything else typed stays).
  let lastText = d0.figures.fee_text;
  fee.addEventListener('change', async () => {
    try {
      const r = await attempt(() => api(`/deals/${dealId}/referral-invoice?fee_ex_gst=${encodeURIComponent(fee.value)}`));
      showSums(r.figures);
      body.value = body.value.split(lastText).join(r.figures.fee_text);
      lastText = r.figures.fee_text;
    } catch { /* toasted */ }
  });
  const send = h('button', { type: 'submit' }, 'Send email');
  const form = h('form.ri-form',
    h('p.muted.small', `To ${d0.partner.name}${d0.partner.company ? ` (${d0.partner.company})` : ''}. Check the figures and wording, then send. It goes from your Outlook and is noted on the deal.`),
    h('label.field', h('span', 'To'), to),
    h('div.ri-fee', h('label.field', h('span', 'Referral fee before GST ($)'), fee), sums),
    h('label.field', h('span', 'Subject'), subject),
    h('label.field', h('span', 'Message'), body),
    h('p.small.muted', 'To change the standard wording for next time, edit "Referral fee invoice request" in Email templates.'),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), send));
  const dlg = modal(`Request an invoice from ${d0.partner.name}`, form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    send.disabled = true;
    try {
      const r = await attempt(() => api(`/deals/${dealId}/referral-invoice`, { method: 'POST', body: { to: to.value, subject: subject.value, body: body.value, fee_ex_gst: fee.value } }));
      toast(r.status === 'sent' ? `Invoice request sent to ${to.value}` : r.status === 'logged' ? 'Logged (connect Outlook in Settings to actually send emails)' : `Not sent: ${r.error || r.status}`, r.status === 'failed' ? 'error' : undefined);
      dlg.close();
      onSent?.();
    } catch { send.disabled = false; }
  });
}

// The line on a settled deal: who gets the fee, and the button.
export function referralInvoiceBlock(deal, onSent) {
  const ri = deal.referral_invoice;
  if (!ri?.applies) return null;
  const p = ri.partner;
  const f = ri.figures;
  return h('div.ri-block',
    h('div', h('strong', 'Referral fee: '), `${p.name}${p.company ? ` (${p.company})` : ''} · ${money2(f.fee_inc_gst)}${f.gst_registered ? ' incl. GST' : ' (no GST)'}`),
    ri.requested_at ? h('div.muted.small', `Invoice requested ${dateTime(ri.requested_at)}`) : null,
    !ri.settled ? h('div.muted.small', 'You can ask for their invoice once the loan settles.')
      : !p.email ? h('div.small.text-warn', `Add an email address for ${p.name} on the Partners & agents page to request their invoice.`)
        : h('button.small.secondary', { type: 'button', onclick: () => referralInvoiceDialog(deal.id, onSent) }, ri.requested_at ? '✉ Request invoice again' : '✉ Request invoice'));
}
