// Settlement letter: the loan summary emailed to the client (with a PDF) when
// their loan settles. Filled in by hand or read from the loan documents by AI.
import { api, h, attempt, modal, toast, date, money, money2, badge, state, field, readForm, confirmDialog } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const MAX_FILES = 6;

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
}

// Inputs bound to a path in the details object, e.g. "loans.1.interest_rate".
function editor(details, uncertain) {
  const x = structuredClone(details);
  const flagged = new Set(uncertain || []);
  const flagPath = (path) => path.replace(/^loans\.(\d+)\./, 'loans[$1].');
  const input = (path, attrs = {}) => {
    const parts = path.split('.');
    const get = () => parts.reduce((o, k) => (o == null ? o : o[k]), x);
    const set = (v) => { let o = x; parts.slice(0, -1).forEach((k) => { o = o[k]; }); o[parts.at(-1)] = v; };
    const v = get();
    let el;
    if (attrs.options) {
      el = h('select', { 'aria-label': attrs.label }, attrs.options.map(([val, l]) => h('option', { value: val, selected: String(v ?? '') === val }, l)));
    } else if (attrs.type === 'textarea') {
      el = h('textarea', { rows: attrs.rows || 4, 'aria-label': attrs.label }, v ?? '');
    } else {
      el = h('input', { type: attrs.type || 'text', value: v ?? '', step: attrs.step, placeholder: attrs.placeholder || '', 'aria-label': attrs.label, inputmode: attrs.inputmode });
    }
    const wrap = h(`div.field${attrs.full ? '.full' : ''}${flagged.has(flagPath(path)) ? '.ai-check' : ''}`, h('label', attrs.label), el,
      flagged.has(flagPath(path)) ? h('span.ai-hint', 'AI wasn\'t sure: please check') : null);
    el.addEventListener('input', () => {
      let val = el.value;
      if (attrs.type === 'number') val = val === '' ? null : Number(val);
      else if (val === '') val = null;
      set(val);
      wrap.classList.remove('ai-check');
      wrap.querySelector('.ai-hint')?.remove();
    });
    return wrap;
  };
  return { x, input };
}

function loanBlock(ed, i, onRemove) {
  const p = (k) => `loans.${i}.${k}`;
  const n = ed.x.loans.length > 1 ? ` ${i + 1}` : '';
  return h('fieldset.sl-loan', h('legend', `Loan account${n}`, ed.x.loans.length > 1 ? h('button.link.small', { type: 'button', onclick: onRemove }, ' Remove') : null),
    h('div.grid-form.sl-grid',
      ed.input(p('product'), { label: 'Product' }),
      ed.input(p('account_number'), { label: 'Account number' }),
      ed.input(p('loan_amount'), { label: 'Loan amount ($)', type: 'number', step: '0.01' }),
      ed.input(p('interest_rate'), { label: 'Interest rate (%)', type: 'number', step: '0.01' }),
      ed.input(p('rate_type'), { label: 'Rate type', options: [['variable', 'Variable'], ['fixed', 'Fixed']] }),
      ed.input(p('fixed_until'), { label: 'Fixed until', type: 'date' }),
      ed.input(p('repayment_type'), { label: 'Repayment type', options: [['pi', 'Principal & interest'], ['io', 'Interest only']] }),
      ed.input(p('io_until'), { label: 'Interest only until', type: 'date' }),
      ed.input(p('repayment_amount'), { label: 'Repayment amount ($)', type: 'number', step: '0.01' }),
      ed.input(p('repayment_frequency'), { label: 'Repayments', options: [['monthly', 'Monthly'], ['fortnightly', 'Fortnightly'], ['weekly', 'Weekly']] }),
      ed.input(p('first_repayment_date'), { label: 'First repayment due', type: 'date' }),
      ed.input(p('loan_term_years'), { label: 'Loan term (years)', type: 'number', step: '1' }),
      ed.input(p('offset_account'), { label: 'Offset account number' })));
}

// The editor: AI reading at the top, then the details.
export async function letterDialog(dealId) {
  let data = await api(`/deals/${dealId}/settlement-letter`);
  let ed;
  const body = h('div.sl-body');
  const notes = h('div.sl-ai-notes');

  // ---- AI reading ----
  const fileIn = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png', multiple: true, hidden: true });
  const chosen = h('span.small.muted');
  const readBtn = h('button', { type: 'button', disabled: true }, '✨ Read documents');
  let files = [];
  fileIn.addEventListener('change', () => {
    files = [...fileIn.files].slice(0, MAX_FILES);
    chosen.textContent = files.length ? files.map((f) => f.name).join(', ') : '';
    readBtn.disabled = !files.length;
  });
  readBtn.addEventListener('click', async () => {
    readBtn.disabled = true;
    readBtn.textContent = 'Reading… (this can take a minute)';
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, data: await readFile(f) })));
      data = await api(`/deals/${dealId}/settlement-letter/read`, { method: 'POST', body: { files: payload, details: ed.x } });
      notes.replaceChildren(h('div.alert.info.small',
        h('strong', `Read ${data.ai_files.length} document${data.ai_files.length === 1 ? '' : 's'}. `),
        data.ai.uncertain.length ? `Fields highlighted in yellow need checking. ` : 'Check the details below before sending. ',
        data.ai.notes.length ? h('ul', data.ai.notes.map((n) => h('li', n))) : null));
      render(data.details, data.ai.uncertain);
      toast('Details filled in from the documents');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      readBtn.textContent = '✨ Read documents';
      readBtn.disabled = !files.length;
    }
  });
  const aiBox = data.ai_configured
    ? h('section.sl-ai',
      h('div', h('strong', 'Fill in from the loan documents'),
        h('p.small.muted', 'Upload the loan contract or offer, the settlement letter and the direct debit form (PDF, JPG or PNG, up to 6 files). AI reads them and fills in the details below for you to check. The files are sent to Anthropic (Claude) to be read and aren\'t stored in the CRM.')),
      h('div.sl-ai-actions', h('button.secondary', { type: 'button', onclick: () => fileIn.click() }, 'Choose files'), readBtn, chosen, fileIn))
    : h('p.small.muted.sl-ai', state.user.role === 'admin' ? 'Tip: add an Anthropic API key in Settings → AI document reading to fill this in from the loan documents.' : 'Tip: an admin can switch on AI reading of loan documents in Settings.');

  function render(details, uncertain = details.uncertain) {
    ed = editor(details, uncertain);
    const loans = h('div.sl-loans');
    const drawLoans = () => loans.replaceChildren(...ed.x.loans.map((_, i) => loanBlock(ed, i, () => { ed.x.loans.splice(i, 1); drawLoans(); })));
    drawLoans();
    const lenders = state.lenders.filter((l) => l.active || l.id === ed.x.lender_id);
    const lenderSel = h('select', { 'aria-label': 'Lender' }, h('option', { value: '' }, 'Other…'), lenders.map((l) => h('option', { value: l.id, selected: l.id === ed.x.lender_id }, l.name)));
    lenderSel.addEventListener('change', () => {
      const l = lenders.find((v) => String(v.id) === lenderSel.value);
      ed.x.lender_id = l ? l.id : null;
      if (l) { ed.x.lender_name = l.name; nameBox.querySelector('input').value = l.name; }
    });
    const nameBox = ed.input('lender_name', { label: 'Lender name (as shown on the letter)' });
    const showFull = h('input', { type: 'checkbox', checked: Boolean(ed.x.direct_debit.show_full) });
    showFull.addEventListener('change', () => { ed.x.direct_debit.show_full = showFull.checked; });
    body.replaceChildren(
      h('h3', 'Borrowers & loan'),
      h('div.grid-form.sl-grid',
        ed.input('borrowers', { label: 'Borrowers', full: true }),
        h('div.field', h('label', 'Lender'), lenderSel), nameBox,
        ed.input('settlement_date', { label: 'Settlement date', type: 'date' }),
        ed.input('lender_phone', { label: 'Lender phone (customer service)' }),
        ed.input('property_address', { label: 'Security property', full: true })),
      loans,
      h('button.link.small', { type: 'button', onclick: () => { ed.x.loans.push({ rate_type: 'variable', repayment_type: 'pi', repayment_frequency: 'monthly' }); drawLoans(); } }, '+ Add a loan split'),
      h('h3', 'Direct debit account'),
      h('div.grid-form.sl-grid',
        ed.input('direct_debit.bank', { label: 'Bank' }),
        ed.input('direct_debit.account_name', { label: 'Account name' }),
        ed.input('direct_debit.bsb', { label: 'BSB', placeholder: '000-000', inputmode: 'numeric' }),
        ed.input('direct_debit.account_number', { label: 'Account number', inputmode: 'numeric' }),
        h('label.field.check.full', showFull, 'Show the full account number (otherwise only the last 4 digits are shown)')),
      h('h3', 'Letter wording'),
      h('div.grid-form',
        ed.input('intro', { label: 'Opening', type: 'textarea', rows: 5, full: true }),
        ed.input('next_steps', { label: 'What happens next (start lines with • for bullets)', type: 'textarea', rows: 5, full: true })));
  }
  render(data.details);

  const save = async () => {
    try {
      data = await api(`/deals/${dealId}/settlement-letter`, { method: 'PUT', body: { details: { ...ed.x, uncertain: [] } } });
      return data;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  };
  const d = modal('Settlement letter', [
    aiBox, notes, body,
    h('div.actions.sl-actions',
      h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'),
      h('button.secondary', { type: 'button', onclick: async () => { if (await save()) { d.close(); previewDialog(dealId); } } }, 'Save & preview'),
      h('button', { type: 'button', onclick: async () => { if (await save()) { toast('Settlement letter saved'); d.close(); refresh(); } } }, 'Save')),
  ], { wide: true });
  d.classList.add('sl-dialog');
}

export function previewDialog(dealId) {
  const frame = h('iframe.sl-frame', { src: `/api/deals/${dealId}/settlement-letter/preview?t=${Date.now()}`, sandbox: 'allow-same-origin', title: 'Settlement letter preview' });
  const d = modal('Settlement letter preview', [
    frame,
    h('div.actions',
      h('a.button.secondary', { href: `/api/deals/${dealId}/settlement-letter/pdf`, download: '' }, 'Download PDF'),
      h('button.secondary', { type: 'button', onclick: () => { d.close(); letterDialog(dealId); } }, 'Edit'),
      h('button', { type: 'button', onclick: () => { d.close(); emailDialog(dealId); } }, 'Email to client')),
  ], { wide: true });
  d.classList.add('sl-dialog');
}

export async function emailDialog(dealId) {
  const data = await api(`/deals/${dealId}/settlement-letter`);
  const fields = [
    { name: 'to', label: 'To', type: 'email', required: true, full: true },
    { name: 'subject', label: 'Subject', required: true, full: true },
    { name: 'body', label: 'Message (the letter is attached as a PDF)', type: 'textarea', rows: 14, required: true, full: true },
  ];
  const form = h('form.grid-form',
    data.missing.length ? h('div.alert.warn-box.small.full', h('strong', 'Not filled in yet: '), data.missing.join(', '), '. You can still send it, but the letter will show "–" for these.') : null,
    fields.map((f) => field(f, data.email[f.name])),
    h('p.small.muted.full', 'Sent from your connected mailbox, branded with your signature, with "Settlement letter – ', data.details.borrowers || 'client', '.pdf" attached.'),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Send')));
  const d = modal('Email the settlement letter', form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api(`/deals/${dealId}/settlement-letter/email`, { method: 'POST', body: readForm(form, fields) });
      toast(r.outbox.status === 'logged' ? 'Logged (no mailbox connected, so it wasn\'t actually emailed)' : `Settlement letter sent to ${r.sent_to}`);
      d.close();
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// Card on the deal page.
export async function settlementLetterCard(deal) {
  const data = await api(`/deals/${deal.id}/settlement-letter`);
  if (!data.saved && !data.suggested) return null;
  const x = data.details;
  const firstRepay = x.loans.map((l) => l.first_repayment_date).filter(Boolean).sort()[0];
  const total = x.loans.reduce((s, l) => s + (l.loan_amount || 0), 0);
  const repay = x.loans.filter((l) => l.repayment_amount).map((l) => `${money2(l.repayment_amount)}/${{ weekly: 'wk', fortnightly: 'fn', monthly: 'mth' }[l.repayment_frequency] || 'mth'}`).join(' + ');
  const status = data.status === 'sent' ? badge(`sent ${date(data.sent_at)}`, 'ok') : data.saved ? badge('draft', 'info') : badge('not started');
  return h('section.card.sl-card',
    h('div.card-head', h('h2', 'Settlement letter ', status),
      h('div.actions',
        h('button.small.secondary', { type: 'button', onclick: () => letterDialog(deal.id) }, data.saved ? 'Edit' : 'Prepare letter'),
        data.saved ? h('button.small.secondary', { type: 'button', onclick: () => previewDialog(deal.id) }, 'Preview') : null,
        data.saved ? h('button.small', { type: 'button', onclick: () => emailDialog(deal.id) }, data.status === 'sent' ? 'Send again' : 'Email to client') : null)),
    data.saved
      ? h('dl.info',
        h('div.info-row', h('dt', 'Loan'), h('dd', `${money(total)}${x.loans.length > 1 ? ` in ${x.loans.length} splits` : ''}${x.loans[0]?.interest_rate ? ` · ${x.loans.map((l) => `${l.interest_rate}%`).join(' / ')}` : ''}`)),
        h('div.info-row', h('dt', 'Repayments'), h('dd', repay || '—', firstRepay ? h('span.muted', ` · first due ${date(firstRepay)}`) : null)),
        h('div.info-row', h('dt', 'Direct debit'), h('dd', x.direct_debit.bsb ? `${x.direct_debit.bank || ''} ${x.direct_debit.bsb} ••${String(x.direct_debit.account_number || '').slice(-4)}`.trim() : '—')),
        data.ai_read_at ? h('div.info-row', h('dt', 'Read by AI'), h('dd.small', `${data.ai_files.join(', ')} (${date(data.ai_read_at)})`)) : null,
        data.status === 'sent' ? h('div.info-row', h('dt', 'Sent to'), h('dd', `${data.sent_to}${data.sent_by_name ? ` by ${data.sent_by_name}` : ''}`)) : null)
      : h('p.muted.small', 'A summary of the new loan for the client: loan amount, rate, repayments, direct debit account and first repayment date, emailed with a PDF letter when the loan settles.'),
    data.saved && data.missing.length ? h('p.small.text-warn', `Still needed: ${data.missing.join(', ')}`) : null);
}

// Settings card (AI key, and sending automatically at settlement).
export async function aiSettingsCard() {
  const [s, settings] = await Promise.all([api('/ai/status'), api('/settings')]);
  const isAdmin = state.user.role === 'admin';
  const fields = [
    { name: 'api_key', label: s.configured ? 'Anthropic API key (saved, enter a new one to change)' : 'Anthropic API key', type: 'password', placeholder: 'sk-ant-…' },
    { name: 'model', label: `Model (blank = ${s.default_model})`, placeholder: s.default_model },
  ];
  const form = h('form.grid-form',
    h('p.small.muted.full', 'Used to read loan documents (contracts, settlement letters, direct debit forms) and fill in settlement letters. Create a key at console.anthropic.com → API keys. Documents are sent to Anthropic to be read; usage is billed to your Anthropic account (typically a few cents per set of documents).'),
    s.from_environment ? h('p.small.full', 'Using the key from the ANTHROPIC_API_KEY environment variable.') : null,
    fields.map((f) => field(f, f.name === 'model' && s.model !== s.default_model ? s.model : undefined)),
    h('label.field.check.full', h('input', { type: 'checkbox', name: 'auto_send', checked: settings.settlement_letter_auto_send === '1' }),
      'When a deal settles, email the settlement letter automatically if it\'s complete (otherwise you get a task to finish and send it)'),
    isAdmin ? h('div.actions.full',
      s.configured && !s.from_environment ? h('button.link.small', { type: 'button', onclick: async () => {
        if (!(await confirmDialog('Remove the Anthropic API key? AI document reading will stop working.'))) return;
        await attempt(() => api('/ai/config', { method: 'PUT', body: { api_key: '' } }), 'Removed');
        refresh();
      } }, 'Remove key') : null,
      h('button', { type: 'submit' }, 'Save')) : null);
  if (!isAdmin) for (const el of form.elements) el.disabled = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    const body = { model: v.model || '' };
    if (v.api_key) body.api_key = v.api_key;
    const ok = await attempt(() => api('/ai/config', { method: 'PUT', body }));
    if (!ok) return;
    await attempt(() => api('/settings', { method: 'PUT', body: { settlement_letter_auto_send: form.elements.auto_send.checked ? '1' : '0' } }), 'Saved');
    refresh();
  });
  return h('section.card', h('div.card-head', h('h2', 'AI document reading & settlement letters'), badge(s.configured ? 'on' : 'off', s.configured ? 'ok' : '')), form);
}
