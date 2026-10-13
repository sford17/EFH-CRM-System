// Purchase calculation: purchase price, loan and LVR, then the costs
// (deposit, stamp duty, LMI, legal and anything else) adding up to what the
// client needs to contribute. Used on the Calculators page and on deals.
import { api, h, money, attempt, confirmDialog, toast, date } from '../core.js';

const STATES = [['NSW', 'NSW'], ['VIC', 'VIC'], ['QLD', 'QLD'], ['WA', 'WA'], ['SA', 'SA'], ['TAS', 'TAS'], ['ACT', 'ACT'], ['NT', 'NT']];
const TYPES = [['established', 'Established home'], ['new', 'New home'], ['off_the_plan', 'Off-the-plan'], ['land', 'Vacant land'], ['commercial', 'Commercial']];
const COST_SUGGESTIONS = ['Transfer registration fee', 'Mortgage registration fee', 'Building & pest inspection', 'Strata report', 'Lender application fee',
  'Valuation fee', 'Conveyancing searches', 'Moving costs', 'Less: First Home Owner Grant'];
export const DEFAULT_INPUTS = {
  purchase_price: 850000, loan_basis: 'lvr', loan_amount: null, lvr: 80, state: 'NSW', property_type: 'established', buyer: 'owner',
  first_home: false, foreign: false, stamp_duty: null, lmi: null, lmi_capitalised: false, legal_costs: 2000, other_costs: [], funds_available: null,
};

const parse = (v) => {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  return s === '' || Number.isNaN(Number(s)) ? null : Number(s);
};
const fmt = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 }));
const pctText = (n) => `${Number(n).toFixed(2).replace(/\.?0+$/, '')}%`;

function moneyInput(name, value, attrs = {}) {
  const el = h('input.pc-input', { type: 'text', inputmode: 'decimal', name, value: fmt(value), autocomplete: 'off', ...attrs });
  el.addEventListener('blur', () => { const n = parse(el.value); if (n !== null) el.value = fmt(n); });
  return el;
}

// Returns { el, inputs() }. `onSave(inputs, { apply })` adds Save buttons (deals).
export function purchaseCalculator(initial = DEFAULT_INPUTS, { onSave = null, onReset = null, savedNote = null } = {}) {
  const i = { ...DEFAULT_INPUTS, ...initial, other_costs: (initial.other_costs || []).map((c) => ({ ...c })) };
  let basis = i.loan_basis === 'lvr' ? 'lvr' : 'amount';
  let last = null;

  // ---- Purchase details used for stamp duty ----------------------------------
  const sel = (name, options, value, labelText) => {
    const el = h('select', { name, 'aria-label': labelText }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    return h('label.pc-opt', h('span', labelText), el);
  };
  const check = (name, value, labelText) => h('label.pc-check', h('input', { type: 'checkbox', name, checked: Boolean(value) }), labelText);
  const options = h('div.pc-options',
    sel('state', STATES, i.state, 'State'),
    sel('property_type', TYPES, i.property_type, 'Property'),
    sel('buyer', [['owner', 'Live in'], ['investor', 'Investment']], i.buyer, 'Buying to'),
    check('first_home', i.first_home, 'First home buyer'),
    check('foreign', i.foreign, 'Foreign purchaser'));

  // ---- The table -----------------------------------------------------------------
  const price = moneyInput('purchase_price', i.purchase_price, { 'aria-label': 'Purchase price', required: true });
  const loan = moneyInput('loan_amount', basis === 'amount' ? i.loan_amount : null, { 'aria-label': 'Loan amount' });
  const lvr = h('input.pc-input.pc-pct', { type: 'text', inputmode: 'decimal', name: 'lvr', value: i.lvr ?? '', 'aria-label': 'LVR (%)', autocomplete: 'off' });
  const duty = moneyInput('stamp_duty', i.stamp_duty, { 'aria-label': 'Stamp duty' });
  const lmi = moneyInput('lmi', i.lmi, { 'aria-label': 'LMI fee' });
  const lmiCap = h('input', { type: 'checkbox', name: 'lmi_capitalised', checked: Boolean(i.lmi_capitalised) });
  const legal = moneyInput('legal_costs', i.legal_costs, { 'aria-label': 'Legal costs' });
  const funds = moneyInput('funds_available', i.funds_available, { 'aria-label': 'Funds available', placeholder: 'Optional' });

  const cell = () => h('span.pc-sub');
  const subs = { loan: cell(), lvr: cell(), deposit: cell(), duty: cell(), lmi: cell(), total: cell(), surplus: cell() };
  const depositVal = h('strong.pc-value');
  const totalVal = h('strong.pc-total-value');
  const surplusVal = h('strong.pc-value');
  const listId = `pc_costs_${Math.random().toString(36).slice(2, 7)}`;
  const otherBody = h('tbody.pc-other');
  const surplusRow = h('tr.pc-surplus', h('th', { scope: 'row' }, 'Shortfall / surplus'), h('td', surplusVal, subs.surplus));
  const messages = h('div.pc-messages');
  const status = h('p.pc-status.muted.small', { role: 'status' });

  const row = (labelText, control, sub, cls = '') => h(`tr${cls}`, h('th', { scope: 'row' }, labelText), h('td', control, sub));
  const otherRow = (c = { label: '', amount: null }) => {
    const labelIn = h('input.pc-label', { type: 'text', list: listId, value: c.label || '', placeholder: 'e.g. Building & pest inspection', 'aria-label': 'Cost description' });
    const amountIn = moneyInput('other_amount', c.amount, { 'aria-label': 'Cost amount' });
    const tr = h('tr.pc-other-row',
      h('th', { scope: 'row' }, labelIn),
      h('td', h('div.pc-inline', amountIn, h('button.icon.small', { type: 'button', 'aria-label': 'Remove this cost', onclick: () => { tr.remove(); recalc(); } }, '×'))));
    return tr;
  };
  otherBody.append(...i.other_costs.map(otherRow));
  const addCost = h('button.link.small', { type: 'button', onclick: () => { const tr = otherRow(); otherBody.append(tr); tr.querySelector('input').focus(); } }, '+ Add a cost');

  const tableEl = h('table.pc-table',
    h('tbody',
      row('Purchase price', price, null, '.pc-key'),
      row('Loan amount', loan, subs.loan),
      row('LVR', h('div.pc-inline', lvr, h('span.muted', '%')), subs.lvr)),
    h('tbody.pc-costs',
      h('tr.pc-heading', h('th', { colspan: 2 }, 'Costs')),
      row('Deposit required', depositVal, subs.deposit),
      row('Stamp duty', duty, subs.duty),
      row('LMI fee', h('div.pc-inline', lmi, h('label.pc-check.small', lmiCap, 'Add to the loan')), subs.lmi),
      row('Legal costs', legal)),
    otherBody,
    h('tbody',
      h('tr.pc-add', h('td', { colspan: 2 }, addCost, h('datalist', { id: listId }, COST_SUGGESTIONS.map((s) => h('option', { value: s }))))),
      h('tr.pc-total', h('th', { scope: 'row' }, 'Total contribution'), h('td', totalVal, subs.total)),
      row('Funds available', funds, null, '.pc-funds'),
      surplusRow));

  const inputs = () => ({
    purchase_price: parse(price.value),
    loan_basis: basis,
    loan_amount: parse(loan.value),
    lvr: parse(lvr.value),
    state: options.querySelector('[name=state]').value,
    property_type: options.querySelector('[name=property_type]').value,
    buyer: options.querySelector('[name=buyer]').value,
    first_home: options.querySelector('[name=first_home]').checked,
    foreign: options.querySelector('[name=foreign]').checked,
    stamp_duty: parse(duty.value),
    lmi: parse(lmi.value),
    lmi_capitalised: lmiCap.checked,
    legal_costs: parse(legal.value) ?? 0,
    other_costs: [...otherBody.querySelectorAll('tr')].map((tr) => ({ label: tr.querySelector('.pc-label').value.trim(), amount: parse(tr.querySelector('[name=other_amount]').value) }))
      .filter((c) => c.label || c.amount !== null),
    funds_available: parse(funds.value),
  });

  const reset = (el, label) => h('button.link.small', { type: 'button', onclick: () => { el.value = ''; recalc(); } }, label);
  function show(r) {
    last = r;
    status.textContent = '';
    // Keep the loan and LVR in step, without overwriting the one being typed in.
    if (document.activeElement !== loan) loan.value = fmt(r.loan_amount);
    if (document.activeElement !== lvr) lvr.value = r.lvr;
    subs.loan.replaceChildren(r.lmi.capitalised && r.lmi.amount ? `Total loan with LMI ${money(r.total_loan)}` : `No LMI up to ${money(r.max_loan_without_lmi)} (80%)`);
    subs.lvr.replaceChildren(r.lmi.capitalised && r.lmi.amount ? `${pctText(r.lvr_incl_lmi)} including LMI` : r.lvr > 80 ? 'Over 80%: LMI applies' : '');
    subs.lvr.className = `pc-sub${r.lvr > 90 ? ' text-danger' : r.lvr > 80 ? ' text-warn' : ''}`;
    depositVal.textContent = money(r.deposit_required);
    subs.deposit.replaceChildren(`${pctText(r.deposit_pct)} of the price`);
    duty.placeholder = fmt(r.stamp_duty.auto_amount);
    subs.duty.replaceChildren(...(r.stamp_duty.overridden
      ? [`Entered by you (estimate ${money(r.stamp_duty.auto_amount)}) · `, reset(duty, 'Use estimate')]
      : [`Estimate${r.stamp_duty.label ? ` · ${r.stamp_duty.label}` : ''}`,
        ...(r.stamp_duty.calculator ? [' · ', h('a', { href: r.stamp_duty.calculator, target: '_blank', rel: 'noopener noreferrer' }, 'official calculator ↗')] : [])]));
    lmi.placeholder = r.lmi.auto_amount === null ? 'Quote needed' : fmt(r.lmi.auto_amount);
    subs.lmi.replaceChildren(...[
      ...(r.lmi.overridden ? ['Entered by you · ', reset(lmi, 'Use estimate')]
        : [r.lvr > 80 ? 'Indicative estimate. Get a quote from the lender.' : 'Not needed at 80% LVR or below']),
      r.lmi.capitalised && r.lmi.amount ? ` Added to the loan (${money(r.lmi.amount)}), so it isn't part of the contribution.` : null,
    ].filter(Boolean));
    totalVal.textContent = money(r.total_contribution);
    subs.total.replaceChildren(`Deposit ${money(r.deposit_required)} + costs ${money(r.costs_total)}`);
    surplusRow.hidden = r.surplus === null;
    if (r.surplus !== null) {
      surplusVal.textContent = `${r.surplus < 0 ? '−' : ''}${money(Math.abs(r.surplus))}`;
      surplusVal.className = `pc-value ${r.surplus < 0 ? 'text-danger' : 'text-ok'}`;
      subs.surplus.replaceChildren(r.surplus < 0 ? 'Shortfall: the client needs this much more' : 'Left over after settlement');
    }
    messages.replaceChildren(...[
      r.warnings.length ? h('div.alert.warn-box.small', r.warnings.map((w) => h('div', w))) : null,
      r.notes.length ? h('ul.duty-notes.small', r.notes.map((n) => h('li', n))) : null,
    ].filter(Boolean));
  }

  let timer = null;
  let seq = 0;
  async function recalc() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      const body = inputs();
      if (!body.purchase_price) { status.textContent = 'Enter the purchase price.'; return; }
      try {
        const r = await api('/calculators/purchase', { method: 'POST', body });
        if (mine === seq) show(r);
      } catch (err) {
        if (mine === seq) status.textContent = err.message;
      }
    }, 250);
  }

  loan.addEventListener('input', () => { basis = 'amount'; recalc(); });
  lvr.addEventListener('input', () => { basis = 'lvr'; recalc(); });
  const root = h('div.purchase-calc', options, h('div.table-wrap', tableEl), status, messages);
  root.addEventListener('input', (e) => { if (e.target !== loan && e.target !== lvr) recalc(); });
  root.addEventListener('change', (e) => { if (e.target.matches('select, input[type=checkbox]')) recalc(); });

  if (onSave) {
    const save = async (apply) => {
      const btns = root.querySelectorAll('.pc-actions button');
      btns.forEach((b) => { b.disabled = true; });
      try {
        await onSave(inputs(), { apply });
      } finally {
        btns.forEach((b) => { b.disabled = false; });
      }
    };
    root.append(h('div.pc-actions',
      savedNote ? h('span.muted.small', savedNote) : null,
      h('span.spacer'),
      onReset ? h('button.secondary.small', { type: 'button', onclick: onReset }, 'Start again from the deal') : null,
      h('button.secondary', { type: 'button', title: 'Also copy the purchase price, loan amount and deposit onto the deal', onclick: () => save(true) }, 'Save & update deal'),
      h('button', { type: 'button', onclick: () => save(false) }, 'Save')));
  }
  recalc();
  return { el: root, inputs, result: () => last };
}

// Calculators page card.
export function purchaseCalcCard() {
  let calc = purchaseCalculator();
  const holder = h('div', calc.el);
  const resetBtn = h('button.secondary.small', { type: 'button', onclick: () => { calc = purchaseCalculator(); holder.replaceChildren(calc.el); } }, 'Reset');
  return h('section.card.pc-card',
    h('div.card-head', h('h2', 'Purchase calculation – funds to complete'), resetBtn),
    h('p.muted.small', 'Enter the purchase price, then either the loan amount or the LVR (each updates the other). Stamp duty and LMI are estimated for you. Type over them to use your own figures, and add any other costs.'),
    holder);
}

// Deal page card (purchase deals, or any deal with a saved calculation).
export async function dealPurchaseCard(deal) {
  const data = await api(`/deals/${deal.id}/purchase-calc`);
  if (!data.suggested && !data.saved) return null;
  const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
  const calc = purchaseCalculator(data.inputs, {
    savedNote: data.saved ? `Saved ${date(data.updated_at)}${data.updated_by_name ? ` by ${data.updated_by_name}` : ''}` : 'Not saved yet. Started from the deal\'s figures.',
    onSave: async (inputs, { apply }) => {
      await api(`/deals/${deal.id}/purchase-calc`, { method: 'PUT', body: { inputs, apply_to_deal: apply } });
      toast(apply ? 'Saved, and the deal\'s price, loan amount and deposit updated' : 'Purchase calculation saved');
      refresh();
    },
    onReset: data.saved ? async () => {
      if (!(await confirmDialog('Clear this saved calculation and start again from the deal\'s figures?'))) return;
      await attempt(() => api(`/deals/${deal.id}/purchase-calc`, { method: 'DELETE' }), 'Cleared');
      refresh();
    } : null,
  });
  return h('section.card.pc-card',
    h('div.card-head', h('h2', 'Purchase calculation'), data.saved && data.result ? h('span.pc-headline', 'Client contribution ', h('strong', money(data.result.total_contribution))) : null),
    calc.el);
}
