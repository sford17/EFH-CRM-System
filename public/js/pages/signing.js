// Adobe Acrobat Sign: send documents for e-signature, track who has signed,
// chase, cancel, and download the signed copy.
import { api, h, attempt, modal, confirmDialog, toast, date, dateTime, fullName, state, label } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const STATUS = {
  sending: ['Sending…', 'warn'],
  out_for_signature: ['Waiting for signatures', 'warn'],
  signed: ['Signed', 'ok'],
  declined: ['Declined', 'danger'],
  cancelled: ['Cancelled', ''],
  expired: ['Expired', 'danger'],
  failed: ['Not sent', 'danger'],
};
const SIGNER = { signed: '✓ signed', waiting: 'waiting to sign', not_yet: 'after the others', declined: '✗ declined', cancelled: 'cancelled', expired: 'expired' };
const statusBadge = (s) => h(`span.badge${STATUS[s]?.[1] ? `.${STATUS[s][1]}` : ''}`, STATUS[s]?.[0] || label(s));

const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That file could not be read'));
  r.readAsDataURL(file);
});

// "Documents for signing" card on a contact or deal.
export function signingCard({ requests, contact, deal = null }) {
  const act = (fn) => async () => { try { await fn(); refresh(); } catch { /* shown */ } };
  const remind = (r) => act(async () => {
    const res = await attempt(() => api(`/signing/requests/${r.id}/remind`, { method: 'POST', body: {} }));
    toast(`Reminder sent to ${res.reminded} signer${res.reminded === 1 ? '' : 's'}`);
  });
  const cancel = (r) => async () => {
    if (!(await confirmDialog(`Cancel "${r.name}"? Adobe Sign will let the signers know it's no longer needed.`))) return;
    await act(() => attempt(() => api(`/signing/requests/${r.id}/cancel`, { method: 'POST', body: {} }), 'Cancelled'))();
  };
  const check = (r) => act(async () => {
    const res = await attempt(() => api(`/signing/requests/${r.id}/refresh`, { method: 'POST', body: {} }));
    toast(res.status === 'signed' ? 'All signed – signed copy saved' : 'Up to date');
  });
  return h('section.card',
    h('div.card-head', h('h2', 'Documents for signing'),
      h('button.small', { type: 'button', onclick: () => sendForSigningDialog({ contact, deal }) }, '✍ Send for signing')),
    requests.length
      ? h('ul.plain.sign-list', requests.map((r) => h('li',
        h('div', h('strong', r.name), ' ', statusBadge(r.status)),
        h('div.muted.small', [
          r.sent_at ? `Sent ${dateTime(r.sent_at)}` : `Created ${dateTime(r.created_at)}`,
          r.sender_name ? ` by ${r.sender_name}` : '',
          r.deal_title && !deal ? ` · ${r.deal_title}` : '',
          r.completed_at && r.status === 'signed' ? ` · signed ${date(r.completed_at)}` : '',
        ].join('')),
        h('ul.signer-list', r.signers.map((s) => h(`li.signer.${s.status}`, s.name, h('span.muted', ` – ${SIGNER[s.status] || s.status}`)))),
        r.error ? h('div.small.text-danger', r.error) : null,
        h('div.row-actions',
          r.has_signed_pdf ? h('a.small', { href: `/api/signing/requests/${r.id}/signed.pdf`, download: '' }, '⬇ Signed copy (PDF)') : null,
          r.status === 'out_for_signature' ? [
            h('button.link.small', { type: 'button', onclick: check(r) }, 'Check now'),
            h('button.link.small', { type: 'button', onclick: remind(r) }, 'Send reminder'),
            h('button.link.small', { type: 'button', onclick: cancel(r) }, 'Cancel'),
          ] : null))))
      : h('p.empty', 'Nothing sent for signing yet. Send a PDF or Word document through Adobe Sign for the client to sign electronically.'));
}

export async function sendForSigningDialog({ contact, deal = null }) {
  const status = await api('/signing/status');
  if (!status.connected) {
    const box = modal('Send for signing', [
      h('p', 'Adobe Sign isn\'t connected yet.'),
      state.user.role === 'admin'
        ? h('div.actions', h('a.button', { href: '#/settings', onclick: () => box.close() }, 'Connect it in Settings'))
        : h('p.muted.small', 'Ask an admin to connect it in Settings.'),
    ]);
    return;
  }
  const c = contact.deals ? contact : await api(`/contacts/${contact.id}`);
  const members = c.household?.length ? c.household : [c];
  const reviews = c.reviews || [];

  // Document: upload, or one of the client's lending reviews.
  const source = h('select', { 'aria-label': 'Document' },
    h('option', { value: 'upload' }, 'Upload a PDF or Word document…'),
    reviews.map((r) => h('option', { value: `review:${r.id}` }, `Lending review: ${r.title} (${date(r.review_date)})`)));
  const fileInput = h('input', { type: 'file', accept: '.pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword', 'aria-label': 'Document file' });
  const name = h('input', { type: 'text', placeholder: 'e.g. Privacy consent & credit guide', 'aria-label': 'Document name' });
  fileInput.addEventListener('change', () => { if (fileInput.files[0] && !name.value) name.value = fileInput.files[0].name.replace(/\.[^.]+$/, ''); });
  source.addEventListener('change', () => {
    fileInput.hidden = source.value !== 'upload';
    if (source.value.startsWith('review:')) name.value = source.selectedOptions[0].textContent.replace(/^Lending review: /, '').replace(/ \(.*\)$/, '');
  });

  // Signers: the client and their household, plus anyone else.
  const signerRows = h('div.signer-rows');
  const addSignerRow = (s = {}, checked = true) => {
    const tick = h('input', { type: 'checkbox', checked, 'aria-label': `Include ${s.name || 'signer'}` });
    const n = h('input', { type: 'text', value: s.name || '', placeholder: 'Name', 'aria-label': 'Signer name' });
    const e = h('input', { type: 'email', value: s.email || '', placeholder: 'Email', 'aria-label': 'Signer email' });
    const row = h('div.signer-row', tick, n, e, s.contact_id ? null : h('button.icon.small', { type: 'button', 'aria-label': 'Remove signer', onclick: () => row.remove() }, '×'));
    row.read = () => (tick.checked ? { name: n.value.trim(), email: e.value.trim(), contact_id: s.contact_id || null } : null);
    signerRows.append(row);
  };
  members.forEach((m, i) => addSignerRow({ name: fullName(m), email: m.email || '', contact_id: m.id }, i === 0 || members.length > 1));
  const order = h('select', { 'aria-label': 'Signing order' },
    h('option', { value: 'parallel' }, 'Everyone can sign at the same time'),
    h('option', { value: 'sequential' }, 'One after another, in the order listed'));
  const brokerSigns = h('input', { type: 'checkbox' });

  // Optional link to a deal (and a checklist item to tick off when signed).
  const deals = c.deals || [];
  const dealSel = h('select', { 'aria-label': 'Deal' }, h('option', { value: '' }, 'Not linked to a deal'),
    deals.map((d) => h('option', { value: d.id, selected: deal?.id === d.id }, d.title)));
  const docSel = h('select', { 'aria-label': 'Checklist item' });
  const loadDocs = async () => {
    docSel.replaceChildren(h('option', { value: '' }, 'Don\'t tick off a checklist item'));
    docSel.hidden = !dealSel.value;
    if (!dealSel.value) return;
    const d = await api(`/deals/${dealSel.value}`);
    docSel.append(...d.documents.filter((x) => ['required', 'requested'].includes(x.status)).map((x) => h('option', { value: x.id }, `Tick off "${x.name}" when signed`)));
  };
  dealSel.addEventListener('change', loadDocs);
  await loadDocs();

  const message = h('textarea', { rows: 3, 'aria-label': 'Message to signers', placeholder: 'Shown in the email from Adobe Sign' },
    `Hi ${members.map((m) => m.first_name).join(' and ')}, please review and sign this document. Any questions, just let me know. Thanks!`);
  const reminder = h('select', { 'aria-label': 'Reminders' },
    h('option', { value: 'every_3_days' }, 'Remind every 3 days until signed'),
    h('option', { value: 'daily' }, 'Remind daily until signed'),
    h('option', { value: 'weekly' }, 'Remind weekly until signed'),
    h('option', { value: '' }, 'No automatic reminders'));
  const expires = h('select', { 'aria-label': 'Expiry' },
    h('option', { value: '' }, 'No expiry'), [7, 14, 30, 60].map((n) => h('option', { value: n, selected: n === 30 }, `Expires after ${n} days`)));

  const send = h('button', { type: 'submit' }, 'Send via Adobe Sign');
  const form = h('form.sign-form',
    h('div.field', h('label', 'Document'), source, fileInput),
    h('div.field', h('label', 'Name shown to signers'), name),
    h('div.field', h('label', 'Who needs to sign'), signerRows,
      h('button.link.small', { type: 'button', onclick: () => addSignerRow({}, true) }, '+ Add another signer'),
      order,
      h('label.check-inline', brokerSigns, ` I need to sign too (after ${members.length > 1 ? 'the clients' : 'the client'}), as ${state.user.name}`)),
    h('div.field', h('label', 'Deal'), dealSel, docSel),
    h('div.field', h('label', 'Message'), message),
    h('div.grid-2.tight', reminder, expires),
    h('p.muted.small', 'Adobe Sign emails each signer a secure link. If the document has no signature fields, Adobe adds a signature block at the end. Signed copies are saved here automatically.'),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), send));
  const dlg = modal(`Send for signing – ${fullName(c)}`, form, { wide: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const signers = [...signerRows.children].map((r) => r.read()).filter(Boolean);
    const body = {
      contact_id: c.id, deal_id: Number(dealSel.value) || null, document_id: Number(docSel.value) || null,
      name: name.value.trim(), message: message.value.trim(), signers, order: order.value,
      broker_signs: brokerSigns.checked, reminder: reminder.value || null, expires_days: Number(expires.value) || null,
    };
    if (source.value.startsWith('review:')) body.review_id = Number(source.value.split(':')[1]);
    else {
      const f = fileInput.files[0];
      if (!f) return toast('Choose the document to send', 'error');
      if (f.size > 10 * 1024 * 1024) return toast('That file is too large (max 10 MB)', 'error');
      body.file = { name: f.name, data: await readFile(f) };
    }
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      await attempt(() => api('/signing/requests', { method: 'POST', body }), 'Sent – Adobe Sign has emailed the signers');
      dlg.close();
      refresh();
    } catch { /* shown */ } finally {
      send.disabled = false;
      send.textContent = 'Send via Adobe Sign';
    }
  });
}

// Settings card (admins connect; everyone sees the status).
export async function adobeSignSettingsCard() {
  const s = await api('/signing/status');
  const isAdmin = state.user.role === 'admin';
  const key = h('input', { type: 'password', placeholder: 'Paste your Acrobat Sign integration key', 'aria-label': 'Adobe Sign integration key', autocomplete: 'off' });
  const connect = async () => {
    await attempt(() => api('/signing/connect', { method: 'POST', body: { key: key.value } }), 'Adobe Sign connected');
    refresh();
  };
  const disconnect = async () => {
    if (!(await confirmDialog('Disconnect Adobe Sign? Documents already sent keep going in Adobe, but the CRM will stop tracking them until you reconnect.'))) return;
    await attempt(() => api('/signing/disconnect', { method: 'POST', body: {} }), 'Disconnected');
    refresh();
  };
  const asUser = h('input', { type: 'checkbox', checked: s.send_as_user, disabled: !isAdmin });
  asUser.addEventListener('change', () => attempt(() => api('/signing/settings', { method: 'PUT', body: { send_as_user: asUser.checked } }), 'Saved'));
  return h('section.card',
    h('h2', 'Adobe Sign'),
    s.connected
      ? h('div.outlook-status.ok',
        h('div', h('strong', `Connected: ${s.account}`), h('div.muted.small', 'Send documents for signing from any contact or deal.')),
        isAdmin ? h('div.actions', h('button.danger.ghost.small', { type: 'button', onclick: disconnect }, 'Disconnect')) : null)
      : isAdmin
        ? h('div',
          h('ol.setup-steps',
            h('li', 'Sign in to Adobe Acrobat Sign as an account administrator.'),
            h('li', 'Go to ', h('strong', 'Account → Acrobat Sign API → API Information'), ' and click ', h('strong', 'Integration Key'), '.'),
            h('li', 'Name it "EFH CRM" and tick ', h('strong', 'user_read, agreement_read, agreement_write, agreement_send'), '. Save, then open the key (click it → Integration Key) and copy it.'),
            h('li', 'Paste it below and click ', h('strong', 'Connect'), '.')),
          h('div.link-row', key, h('button', { type: 'button', onclick: connect }, 'Connect')),
          h('p.muted.small', 'Integration keys are available on Acrobat Sign business and enterprise plans. If you don\'t see "Acrobat Sign API" in your account menu, ask Adobe support to enable API access.'))
        : h('p.muted', 'Not connected. Ask an admin to connect Adobe Sign.'),
    s.connected ? h('label.field.check', asUser, 'Send as each team member (each broker must also be a user in your Acrobat Sign account; otherwise documents are sent from the connected account)') : null);
}
