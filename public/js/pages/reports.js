import { api, h, pageHeader, table, money, money2, label, state } from '../core.js';
import { columns, barList } from '../charts.js';

const range = { from: '', to: '' };
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'short', year: '2-digit' });

export async function reportsPage() {
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const r = await api(`/reports?${qs}`);
  const dateInput = (key, text) => {
    const el = h('input', { type: 'date', value: range[key] || r[key], 'aria-label': text, title: text });
    el.addEventListener('change', () => { range[key] = el.value; window.dispatchEvent(new Event('crm:refresh')); });
    return el;
  };
  const totalSettled = r.settlements_by_month.reduce((s, m) => s + m.volume, 0);
  const totalCount = r.settlements_by_month.reduce((s, m) => s + m.count, 0);
  const funnelStages = state.meta.stages.filter((s) => s.key !== 'lost');
  const funnel = funnelStages.map((s) => ({ label: s.label, value: r.conversion.find((c) => c.stage === s.key)?.deals || 0 }));

  return h('div',
    pageHeader('Reports', dateInput('from', 'From'), h('span.muted', 'to'), dateInput('to', 'To')),
    h('div.tiles',
      h('div.tile', h('div.tile-label', 'Settled volume'), h('div.tile-value', money(totalSettled)), h('div.tile-sub', `${totalCount} loans`)),
      h('div.tile', h('div.tile-label', 'Average loan size'), h('div.tile-value', totalCount ? money(totalSettled / totalCount) : '—')),
      h('div.tile', h('div.tile-label', 'Average days to settle'), h('div.tile-value', r.avg_days_to_settle != null ? String(r.avg_days_to_settle) : '—')),
      h('div.tile', h('div.tile-label', 'Commission (all entries)'), h('div.tile-value', money(r.commission_by_month.reduce((s, m) => s + m.total, 0))))),
    h('section.card', h('h2', 'Settled volume by month'),
      columns(r.settlements_by_month.map((m) => ({ label: monthName(m.month), value: m.volume })), { format: money, empty: 'No settlements in this period.' })),
    h('div.grid-2',
      h('section.card', h('h2', 'Deals reaching each stage'), h('p.muted.small', 'Count of deals that entered each stage in the period.'),
        barList(funnel, { format: String, empty: 'No stage movement in this period.' })),
      h('section.card', h('h2', 'Lead sources'), table([
        { label: 'Source', value: (s) => label(s.source) },
        { label: 'Contacts', value: (s) => String(s.contacts), class: 'num' },
        { label: 'Settled', value: (s) => String(s.settled), class: 'num' },
        { label: 'Conversion', value: (s) => (s.contacts ? `${Math.round((s.settled / s.contacts) * 100)}%` : '—'), class: 'num' },
        { label: 'Volume', value: (s) => money(s.volume), class: 'num' },
      ], r.lead_sources, { empty: 'No contacts created in this period.' }))),
    h('div.grid-2',
      h('section.card', h('h2', 'Lender split (settled)'), barList(r.lenders.map((l) => ({ label: l.lender, value: l.volume, note: `${l.count}` })), { format: money, empty: 'No settlements in this period.' })),
      h('section.card', h('h2', 'Referral partners'), table([
        { label: 'Partner', value: (p) => `${p.name}${p.company ? ` (${p.company})` : ''}` },
        { label: 'Referrals', value: (p) => String(p.referrals), class: 'num' },
        { label: 'Settled', value: (p) => String(p.settled), class: 'num' },
        { label: 'Volume', value: (p) => money(p.volume), class: 'num' },
      ], r.partners, { empty: 'No referral partners yet.' }))),
    h('div.grid-2',
      h('section.card', h('h2', 'Commission by month'), table([
        { label: 'Month', value: (m) => monthName(m.month) },
        { label: 'Upfront', value: (m) => money2(m.upfront), class: 'num' },
        { label: 'Trail', value: (m) => money2(m.trail), class: 'num' },
        { label: 'Deductions', value: (m) => money2(m.deductions), class: 'num' },
        { label: 'Received', value: (m) => money2(m.received), class: 'num' },
      ], r.commission_by_month, { empty: 'No commission in this period.' })),
      h('section.card', h('h2', 'Why deals were lost'), table([
        { label: 'Reason', value: (l) => l.reason },
        { label: 'Deals', value: (l) => String(l.count), class: 'num' },
      ], r.lost_reasons, { empty: 'No lost deals in this period. 👏' }))),
    h('section.card', h('h2', 'Settlements by month (table)'), table([
      { label: 'Month', value: (m) => monthName(m.month) },
      { label: 'Loans', value: (m) => String(m.count), class: 'num' },
      { label: 'Volume', value: (m) => money(m.volume), class: 'num' },
    ], r.settlements_by_month, { empty: 'No settlements in this period.' })));
}

