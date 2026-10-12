import { api, h, pageHeader, table, badge, money2, money, date, attempt, label, formModal, todayStr } from '../core.js';
import { refresh } from './forms.js';

const f = { status: '', type: '', from: '', to: '' };

export async function commissionsPage() {
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const data = await api(`/commissions?${qs}`);
  const sel = (key, text, options) => {
    const el = h('select', { 'aria-label': text }, h('option', { value: '' }, text), options.map((o) => h('option', { value: o, selected: o === f[key] }, label(o))));
    el.addEventListener('change', () => { f[key] = el.value; refresh(); });
    return el;
  };
  const month = (key, text) => {
    const el = h('input', { type: 'month', value: f[key], 'aria-label': text, title: text });
    el.addEventListener('change', () => { f[key] = el.value; refresh(); });
    return el;
  };
  const addEntry = async () => {
    const { rows } = await api('/deals?stage=settled');
    formModal('Record commission / clawback', [
      { name: 'deal_id', label: 'Deal', type: 'select', required: true, full: true, options: rows.map((d) => [d.id, d.title]) },
      { name: 'type', label: 'Type', type: 'select', required: true, options: ['upfront', 'trail', 'clawback', 'referral_fee', 'other'].map((t) => [t, label(t)]) },
      { name: 'amount', label: 'Amount ($) – clawbacks are saved as negative', type: 'number', required: true },
      { name: 'period', label: 'Period (YYYY-MM)', default: todayStr().slice(0, 7) },
      { name: 'status', label: 'Status', type: 'select', required: true, options: [['expected', 'Expected'], ['received', 'Received'], ['paid', 'Paid']], default: 'received' },
      { name: 'notes', label: 'Notes', full: true },
    ], {}, async (v) => { await attempt(() => api('/commissions', { method: 'POST', body: v }), 'Recorded'); refresh(); });
  };
  const setStatus = async (c, status) => { await attempt(() => api(`/commissions/${c.id}`, { method: 'PATCH', body: { status } })); refresh(); };

  return h('div',
    pageHeader('Commissions', h('button', { type: 'button', onclick: addEntry }, '+ Record entry')),
    h('div.tiles',
      h('div.tile', h('div.tile-label', 'Expected (filtered)'), h('div.tile-value', money(data.totals.expected))),
      h('div.tile', h('div.tile-label', 'Received (filtered)'), h('div.tile-value', money(data.totals.received))),
      h('div.tile', h('div.tile-label', 'Deals in clawback window'), h('div.tile-value', String(data.clawback_exposure.length)),
        h('div.tile-sub', `${money(data.clawback_exposure.reduce((s, d) => s + d.upfront, 0))} upfront at risk`))),
    h('div.filters', sel('status', 'All statuses', ['expected', 'received', 'paid', 'cancelled']), sel('type', 'All types', ['upfront', 'trail', 'clawback', 'referral_fee', 'other']), month('from', 'From month'), month('to', 'To month')),
    h('section.card', h('h2', 'Ledger'), table([
      { label: 'Period', value: (c) => c.period || '—' },
      { label: 'Deal', value: (c) => h('a', { href: `#/deals/${c.deal_id}` }, c.deal_title) },
      { label: 'Lender', value: (c) => c.lender_name || '—' },
      { label: 'Type', value: (c) => label(c.type) },
      { label: 'Amount', value: (c) => h(`span${c.amount < 0 ? '.text-danger' : ''}`, money2(c.amount)), class: 'num' },
      { label: 'Status', value: (c) => badge(c.status, { received: 'ok', paid: 'ok', expected: 'warn', cancelled: '' }[c.status]) },
      {
        label: '', value: (c) => (c.status === 'expected'
          ? h('button.link.small', { type: 'button', onclick: () => setStatus(c, 'received') }, 'Mark received')
          : c.status === 'received' ? h('button.link.small', { type: 'button', onclick: () => setStatus(c, 'expected') }, 'Undo') : null),
      },
    ], data.rows, { empty: 'No commission entries. They are created automatically when deals settle.' })),
    h('section.card', h('h2', 'Clawback exposure'), h('p.muted', 'Settled loans still inside the lender\'s clawback period. If one of these is discharged or refinanced, upfront commission may be clawed back.'),
      table([
        { label: 'Deal', value: (d) => h('a', { href: `#/deals/${d.id}` }, d.title) },
        { label: 'Lender', value: (d) => d.lender_name },
        { label: 'Settled', value: (d) => date(d.settlement_date) },
        { label: 'Clawback until', value: (d) => date(d.clawback_until) },
        { label: 'Upfront', value: (d) => money2(d.upfront), class: 'num' },
      ], data.clawback_exposure, { empty: 'No loans in a clawback window.' })));
}
