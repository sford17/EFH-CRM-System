import { api, h, pageHeader, table, money, money2, label, state, date, userOptions, lenderTag, badge } from '../core.js';
import { columns, barList, stackedColumns } from '../charts.js';

const range = { from: '', to: '' };
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'short', year: '2-digit' });

const tabs = (active) => h('nav.tabs.report-tabs', { 'aria-label': 'Report sections' },
  h(`a${active === 'overview' ? '.active' : ''}`, { href: '#/reports', 'aria-current': active === 'overview' ? 'page' : undefined }, 'Overview'),
  h(`a${active === 'settlements' ? '.active' : ''}`, { href: '#/reports?tab=settlements', 'aria-current': active === 'settlements' ? 'page' : undefined }, 'Settlements'));

export async function reportsPage() {
  if (window.routeQuery?.get('tab') === 'settlements') return settlementsReport();
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
    tabs('overview'),
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


// ---- Running settlements ---------------------------------------------------------------

const settleFilters = { fy: '', owner_id: '' };
const monthLong = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'long', year: 'numeric' });
const COMMISSION_NOTE = { received: 'Received', expected: 'Not yet received', estimated: 'Estimate, from the lender\'s upfront rate' };

function statusCell(d) {
  if (d.settled) return h('span.status-pill.text-ok', '✓ Settled');
  if (d.overdue) return h('span.status-pill.text-danger', `⚠ Overdue · ${d.stage_label}`);
  return h('span.status-pill', `◷ ${d.stage_label}`);
}

function commissionCell(d) {
  if (d.commission === null) return h('span.muted', '—');
  return h('span', { title: `${COMMISSION_NOTE[d.commission_status] || ''}${d.referral_fee ? ` · upfront ${money2(d.commission_upfront)} less referral fee ${money2(d.referral_fee)}` : ''}` },
    d.commission_status === 'estimated' ? '≈ ' : '', money2(d.commission),
    d.commission_status === 'received' ? h('span.text-ok', ' ✓') : null);
}

function dealTable(rows, { subtotal } = {}) {
  const cols = [
    { label: 'Date', value: (d) => (d.settlement_date ? date(d.settlement_date) : '—') },
    { label: 'Client', value: (d) => h('a', { href: `#/deals/${d.deal_id}`, title: d.title }, d.client) },
    { label: 'Lender', value: (d) => lenderTag(d.lender_logo_id, d.lender_name) },
    { label: 'Loan type', value: (d) => h('span', d.loan_type, d.rate_type ? h('div.muted.small', label(d.rate_type)) : null) },
    { label: 'Loan amount', value: (d) => money(d.loan_amount), class: 'num' },
    { label: 'Commission', value: commissionCell, class: 'num' },
    { label: 'Status', value: statusCell },
  ];
  const el = table(cols, rows, { empty: 'Nothing this month.' });
  const body = el.querySelector?.('tbody');
  if (body) {
    rows.forEach((d, i) => { if (!d.settled) body.children[i].classList.add('expected'); });
    if (subtotal) body.append(h('tr.subtotal', h('td', { colSpan: 4 }, subtotal.label), h('td.num', money(subtotal.volume)), h('td.num', money2(subtotal.commission)), h('td')));
  }
  return el;
}

async function settlementsReport() {
  const qs = new URLSearchParams(Object.entries(settleFilters).filter(([, v]) => v)).toString();
  const r = await api(`/reports/settlements?${qs}`);
  const t = r.totals;
  const set = (key) => (e) => { settleFilters[key] = e.target.value; window.dispatchEvent(new Event('crm:refresh')); };
  const fySel = h('select', { 'aria-label': 'Financial year', onchange: set('fy') },
    r.fy_options.map((o) => h('option', { value: o.fy, selected: o.fy === r.fy }, o.label)));
  const ownerSel = h('select', { 'aria-label': 'Broker', onchange: set('owner_id') },
    h('option', { value: '' }, 'All brokers'), userOptions().map(([v, l]) => h('option', { value: v, selected: String(v) === settleFilters.owner_id }, l)));
  const csv = h('a.button.secondary', { href: `/api/reports/settlements.csv?${new URLSearchParams({ fy: r.fy, ...(settleFilters.owner_id ? { owner_id: settleFilters.owner_id } : {}) })}`, download: '' }, 'Export CSV');

  const projected = t.settled_volume + t.expected_volume;
  const tile = (l, v, sub) => h('div.tile', h('div.tile-label', l), h('div.tile-value', v), sub ? h('div.tile-sub', sub) : null);
  const withDeals = r.months.filter((m) => m.settled.length || m.expected.length);

  return h('div',
    pageHeader('Reports', fySel, ownerSel, csv),
    tabs('settlements'),
    h('div.tiles',
      tile('Settled so far', money(t.settled_volume), `${t.settled_count} loan${t.settled_count === 1 ? '' : 's'}`),
      tile('Commission so far', money(t.settled_commission), `${money(t.commission_received)} received`),
      tile('Still expected', money(t.expected_volume), `${t.expected_count} loan${t.expected_count === 1 ? '' : 's'} · ≈ ${money(t.expected_commission)}${t.overdue_count ? ` · ${t.overdue_count} overdue` : ''}`),
      tile(`Projected ${r.fy_label.split(' ')[0]}`, money(projected), t.year_target ? `${Math.round((projected / t.year_target) * 100)}% of ${money(t.year_target)} target` : `≈ ${money(t.settled_commission + t.expected_commission)} commission`)),
    h('section.card', h('h2', `Settlements by month – ${r.fy_label}`),
      h('p.muted.small', 'Settled loans, plus open deals with a settlement date in that month. Commission is upfront after referral fees; ≈ marks an estimate.'),
      stackedColumns(r.months.map((m) => ({
        label: new Date(`${m.month}-01T00:00:00`).toLocaleString('en-AU', { month: 'short' }),
        parts: [m.totals.settled_volume, m.totals.expected_volume],
        highlight: m.current,
        tip: `${monthLong(m.month)}: settled ${money(m.totals.settled_volume)} (${m.totals.settled_count}), expected ${money(m.totals.expected_volume)} (${m.totals.expected_count})`,
      })), { names: ['Settled', 'Expected'], format: money, empty: 'No settlements or expected settlements this year yet.' }),
      h('details.month-table', h('summary.muted.small', 'Month-by-month table with running totals'),
        table([
          { label: 'Month', value: (m) => monthLong(m.month) },
          { label: 'Settled', value: (m) => `${m.totals.settled_count} · ${money(m.totals.settled_volume)}`, class: 'num' },
          { label: 'Commission', value: (m) => money2(m.totals.settled_commission), class: 'num' },
          { label: 'Expected', value: (m) => `${m.totals.expected_count} · ${money(m.totals.expected_volume)}`, class: 'num' },
          { label: 'Est. commission', value: (m) => money2(m.totals.expected_commission), class: 'num' },
          { label: 'Running total', value: (m) => money(m.running_volume), class: 'num' },
          ...(r.monthly_target ? [{ label: 'Running target', value: (m) => money(m.running_target), class: 'num' }] : []),
        ], r.months))),
    withDeals.length ? withDeals.map((m) => h(`section.card.settle-month${m.current ? '.current' : ''}`,
      h('div.card-head', h('h2', monthLong(m.month), m.current ? [' ', badge('this month', 'info')] : null),
        h('div.settle-sub',
          h('span', 'Settled ', h('strong', `${m.totals.settled_count} · ${money(m.totals.settled_volume)}`)),
          m.totals.expected_count ? h('span', 'Expected ', h('strong', `${m.totals.expected_count} · ${money(m.totals.expected_volume)}`)) : null,
          h('span', 'Commission ', h('strong', money2(m.totals.settled_commission + m.totals.expected_commission))),
          h('span', 'Running total ', h('strong', money(m.running_volume))))),
      dealTable([...m.settled, ...m.expected], {
        subtotal: { label: `Total for ${monthLong(m.month)}`, volume: m.totals.settled_volume + m.totals.expected_volume, commission: m.totals.settled_commission + m.totals.expected_commission },
      })))
      : h('section.card', h('p.empty', `No settled or expected loans in ${r.fy_label} yet.`)),
    r.undated.length ? h('section.card.settle-undated',
      h('div.card-head', h('h2', `In progress, no settlement date yet (${r.undated.length})`), h('span.settle-sub', h('span', 'Volume ', h('strong', money(t.undated_volume))))),
      h('p.muted.small', 'Lodged or approved deals without a settlement date. Add the date on the deal and they\'ll appear in their month above.'),
      dealTable(r.undated)) : null);
}
