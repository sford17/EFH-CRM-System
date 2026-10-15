import { api, h, pageHeader, table, money, money2, label, state, date, userOptions, lenderTag, badge, toast } from '../core.js';
import { columns, barList, stackedColumns } from '../charts.js';
import { refinanceDialog, sideCell, heldCell, STATUS_KIND } from './refinances.js';

// One reporting period shared by both tabs: financial year, calendar year or custom dates.
const period = { period: 'fy', fy: '', year: '', from: '', to: '' };
let yearOptions = null;
const periodQuery = () => {
  const q = { period: period.period };
  if (period.period === 'fy' && period.fy) q.fy = period.fy;
  if (period.period === 'cy' && period.year) q.year = period.year;
  if (period.period === 'custom') Object.assign(q, { from: period.from, to: period.to });
  return q;
};

// Period type, then a year or two dates. `current` is the period the report used.
// `allowAll` adds "All dates" (for registers rather than period reports).
async function periodPicker(current, { allowAll = false } = {}) {
  yearOptions = yearOptions || await api('/reports/periods');
  const go = () => window.dispatchEvent(new Event('crm:refresh'));
  const type = h('select', { 'aria-label': 'Report period' },
    [['fy', 'Financial year'], ['cy', 'Calendar year'], ['custom', 'Custom dates'], ...(allowAll ? [['all', 'All dates']] : [])]
      .map(([v, l]) => h('option', { value: v, selected: current.type === v }, l)));
  const yearSel = (key, list, chosen) => {
    const el = h('select', { 'aria-label': key === 'fy' ? 'Financial year' : 'Year' },
      list.map((o) => h('option', { value: o.value, selected: o.value === chosen }, o.label)));
    el.addEventListener('change', () => { period[key] = el.value; go(); });
    return el;
  };
  const from = h('input', { type: 'date', value: current.from, 'aria-label': 'From', title: 'From' });
  const to = h('input', { type: 'date', value: current.to, 'aria-label': 'To', title: 'To' });
  const applyDates = () => {
    if (!from.value || !to.value) return;
    if (from.value > to.value) { to.setCustomValidity('The end date must be after the start date'); to.reportValidity(); return; }
    to.setCustomValidity('');
    Object.assign(period, { period: 'custom', from: from.value, to: to.value });
    go();
  };
  from.addEventListener('change', applyDates);
  to.addEventListener('change', applyDates);
  const detail = current.type === 'all' ? null : current.type === 'fy' ? yearSel('fy', yearOptions.fy, current.fy)
    : current.type === 'cy' ? yearSel('year', yearOptions.cy, current.year)
      : h('span.date-range', from, h('span.muted', 'to'), to);
  type.addEventListener('change', () => {
    period.period = type.value;
    if (type.value === 'custom' && current.from) {
      // Start from the dates being shown, so switching keeps the same view until changed.
      Object.assign(period, { from: current.from, to: current.to });
    }
    go();
  });
  return h('div.period-picker', type, detail);
}
const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'short', year: '2-digit' });

const tabs = (active) => h('nav.tabs.report-tabs', { 'aria-label': 'Report sections' },
  h(`a${active === 'overview' ? '.active' : ''}`, { href: '#/reports', 'aria-current': active === 'overview' ? 'page' : undefined }, 'Overview'),
  h(`a${active === 'settlements' ? '.active' : ''}`, { href: '#/reports?tab=settlements', 'aria-current': active === 'settlements' ? 'page' : undefined }, 'Settlements'),
  h(`a${active === 'refinances' ? '.active' : ''}`, { href: '#/reports?tab=refinances', 'aria-current': active === 'refinances' ? 'page' : undefined }, 'Internal refinances'),
  h(`a${active === 'costs' ? '.active' : ''}`, { href: '#/reports?tab=costs', 'aria-current': active === 'costs' ? 'page' : undefined }, 'Running costs'));

export async function reportsPage() {
  if (window.routeQuery?.get('tab') === 'settlements') return settlementsReport();
  if (window.routeQuery?.get('tab') === 'refinances') return refinancesReport();
  if (window.routeQuery?.get('tab') === 'costs') return costsReport();
  const r = await api(`/reports?${new URLSearchParams(periodQuery())}`);
  const totalSettled = r.settlements_by_month.reduce((s, m) => s + m.volume, 0);
  const totalCount = r.settlements_by_month.reduce((s, m) => s + m.count, 0);
  const funnelStages = state.meta.stages.filter((s) => s.key !== 'lost');
  const funnel = funnelStages.map((s) => ({ label: s.label, value: r.conversion.find((c) => c.stage === s.key)?.deals || 0 }));

  return h('div',
    pageHeader('Reports', await periodPicker(r.period)),
    tabs('overview'),
    h('p.muted.period-label', `Showing ${r.period.label}`),
    h('div.tiles',
      h('div.tile', h('div.tile-label', 'Settled volume'), h('div.tile-value', money(totalSettled)), h('div.tile-sub', `${totalCount} loan${totalCount === 1 ? '' : 's'}`)),
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

const settleFilters = { owner_id: '' };
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
  const q = { ...periodQuery(), ...(settleFilters.owner_id ? { owner_id: settleFilters.owner_id } : {}) };
  const r = await api(`/reports/settlements?${new URLSearchParams(q)}`);
  const t = r.totals;
  const set = (key) => (e) => { settleFilters[key] = e.target.value; window.dispatchEvent(new Event('crm:refresh')); };
  const ownerSel = h('select', { 'aria-label': 'Broker', onchange: set('owner_id') },
    h('option', { value: '' }, 'All brokers'), userOptions().map(([v, l]) => h('option', { value: v, selected: String(v) === settleFilters.owner_id }, l)));
  const csv = h('a.button.secondary', { href: `/api/reports/settlements.csv?${new URLSearchParams(q)}`, download: '' }, 'Export CSV');

  const projected = t.settled_volume + t.expected_volume;
  const tile = (l, v, sub) => h('div.tile', h('div.tile-label', l), h('div.tile-value', v), sub ? h('div.tile-sub', sub) : null);
  const withDeals = r.months.filter((m) => m.settled.length || m.expected.length);

  return h('div',
    pageHeader('Reports', await periodPicker(r.period), ownerSel, csv),
    tabs('settlements'),
    h('div.tiles',
      tile('Settled so far', money(t.settled_volume), `${t.settled_count} loan${t.settled_count === 1 ? '' : 's'}`),
      tile('Commission so far', money(t.settled_commission), `${money(t.commission_received)} received`),
      tile('Still expected', money(t.expected_volume), `${t.expected_count} loan${t.expected_count === 1 ? '' : 's'} · ≈ ${money(t.expected_commission)}${t.overdue_count ? ` · ${t.overdue_count} overdue` : ''}`),
      tile(`Projected ${r.period.short}`, money(projected), t.period_target ? `${Math.round((projected / t.period_target) * 100)}% of ${money(t.period_target)} target` : `≈ ${money(t.settled_commission + t.expected_commission)} commission`)),
    h('section.card', h('h2', `Settlements by month – ${r.period.label}`),
      h('p.muted.small', 'Settled loans, plus open deals with a settlement date in that month. Commission is upfront after referral fees; ≈ marks an estimate.'),
      stackedColumns(r.months.map((m) => ({
        // Longer custom ranges repeat months, so add the year.
        label: new Date(`${m.month}-01T00:00:00`).toLocaleString('en-AU', r.months.length > 12 ? { month: 'short', year: '2-digit' } : { month: 'short' }),
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
      : h('section.card', h('p.empty', `No settled or expected loans in ${r.period.label} yet.`)),
    r.undated.length ? h('section.card.settle-undated',
      h('div.card-head', h('h2', `In progress, no settlement date yet (${r.undated.length})`), h('span.settle-sub', h('span', 'Volume ', h('strong', money(t.undated_volume))))),
      h('p.muted.small', 'Lodged or approved deals without a settlement date. Add the date on the deal and they\'ll appear in their month above.'),
      dealTable(r.undated)) : null);
}

// ---- Internal refinances: clients moved from one of our loans to a new one ----
const refiFilters = { owner_id: '', lender_id: '', status: '', q: '' };
let refiOpened = null;

async function refinancesReport() {
  const q = { ...periodQuery(), ...Object.fromEntries(Object.entries(refiFilters).filter(([, v]) => v)) };
  const r = await api(`/refinances?${new URLSearchParams(q)}`);
  const t = r.totals;
  const set = (key) => (e) => { refiFilters[key] = e.target.value; window.dispatchEvent(new Event('crm:refresh')); };
  const ownerSel = h('select', { 'aria-label': 'Broker', onchange: set('owner_id') },
    h('option', { value: '' }, 'All brokers'), userOptions().map(([v, l]) => h('option', { value: v, selected: String(v) === refiFilters.owner_id }, l)));
  const lenderSel = h('select', { 'aria-label': 'Lender', onchange: set('lender_id') },
    h('option', { value: '' }, 'All lenders'), state.lenders.map((l) => h('option', { value: l.id, selected: String(l.id) === refiFilters.lender_id }, l.name)));
  const statusSel = h('select', { 'aria-label': 'Status', onchange: set('status') },
    [['', 'Any status'], ['needs_review', 'Needs review'], ['in_progress', 'In progress'], ['completed', 'Completed']]
      .map(([v, l]) => h('option', { value: v, selected: v === refiFilters.status }, l)));
  const search = h('input', { type: 'search', placeholder: 'Client, borrower or account…', 'aria-label': 'Search', value: refiFilters.q });
  search.addEventListener('change', set('q'));
  const csv = h('a.button.secondary', { href: `/api/refinances.csv?${new URLSearchParams(q)}`, download: '' }, 'Export CSV');
  const add = h('button', { type: 'button', onclick: () => refinanceDialog() }, '+ Record refinance');
  const tile = (l, v, sub) => h('div.tile', h('div.tile-label', l), h('div.tile-value', v), sub ? h('div.tile-sub', sub) : null);

  // Opened from a notification link (#/reports?tab=refinances&open=ID), once.
  const openId = Number(window.routeQuery?.get('open')) || null;
  if (!openId) refiOpened = null;
  else if (refiOpened !== openId) {
    refiOpened = openId;
    api(`/refinances/${openId}`).then((e) => refinanceDialog(e)).catch((err) => toast(err.message, 'error'));
  }

  return h('div',
    pageHeader('Reports', await periodPicker(r.period, { allowAll: true }), ownerSel, csv, add),
    tabs('refinances'),
    h('div.filters.ir-filters', lenderSel, statusSel, search),
    t.needs_review_count ? h('div.alert.warn-box', h('strong', `${t.needs_review_count} to check. `),
      'These were recorded automatically when a refinance deal settled. Open each one, check both loans and set the status to Completed.') : null,
    h('div.tiles',
      tile('Internal refinances', String(t.count), `${t.completed_count} completed${t.in_progress_count ? ` · ${t.in_progress_count} in progress` : ''}`),
      tile('New lending', money(t.new_volume), `replacing ${money(t.old_volume)}`),
      tile('Within clawback period', String(t.within_clawback_count), t.clawback_amount ? `${money2(t.clawback_amount)} clawed back` : 'of the old lender'),
      tile('Cashbacks', money(t.cashback), 'lender incentives recorded')),
    r.flows.length ? h('section.card', h('h2', `Lender movements – ${r.period.label}`),
      barList(r.flows.map((f) => ({ label: `${f.from} → ${f.to}`, value: f.count, note: money(f.volume) })), { format: (n) => `${n} client${n === 1 ? '' : 's'}` })) : null,
    h('section.card',
      h('div.card-head', h('h2', `Register – ${r.period.label}`), h('span.muted.small', 'Click a row to edit it')),
      table([
        { label: 'Date', value: (x) => date(x.switch_date) },
        { label: 'Client', value: (x) => h('div', x.contact_id ? h('a', { href: `#/contacts/${x.contact_id}?tab=tracker` }, x.client_name) : x.client_name,
          x.reason ? h('div.muted.small', x.reason) : null) },
        { label: 'Existing loan', value: (x) => sideCell(x, 'old') },
        { label: '', value: () => '→', class: 'ir-arrow' },
        { label: 'New loan', value: (x) => sideCell(x, 'new') },
        { label: 'Held', value: heldCell },
        { label: 'Broker', value: (x) => x.new_broker_name || x.old_broker_name || '—' },
        { label: 'Status', value: (x) => h('div', badge(x.status_label, STATUS_KIND[x.status]), x.source === 'auto' ? h('div.muted.small', 'auto') : null) },
      ], r.rows, { onRow: (x) => refinanceDialog(x), empty: `No internal refinances in ${r.period.label}. Use "+ Record refinance" to add one, or choose "All dates".` })));
}

// ---- Running costs: Anthropic (Claude) and SMS ----------------------------------------------------------

const usd = (n) => (n === null || n === undefined ? '—' : `US$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const aud = (n, est = false) => (n === null || n === undefined ? '—' : `${est ? '≈ ' : ''}${money2(n)}`);

function costSettingsForm(s, onSaved) {
  const rate = h('input', { type: 'number', step: '0.0001', min: '0', value: s.usd_to_aud ?? '', placeholder: 'e.g. 1.52', 'aria-label': 'US dollar to Australian dollar rate' });
  const part = h('input', { type: 'number', step: '0.0001', min: '0', value: s.sms_price_per_part ?? '', placeholder: 'e.g. 0.07', 'aria-label': 'Price per SMS part' });
  const save = h('button', { type: 'submit' }, 'Save');
  const form = h('form.grid-form',
    h('label.field', h('span', 'Exchange rate: A$ per US$1'), rate, h('span.small.muted', 'Anthropic charges in US dollars. Add the rate (from your bank or card statement) to see everything in Australian dollars.')),
    h('label.field', h('span', 'Your ClickSend price per SMS part (A$)'), part, h('span.small.muted', 'Used for texts where ClickSend didn\'t report a price. A text over 160 characters is sent in parts.')),
    state.user.role === 'admin' ? h('div.actions.full', save) : h('p.small.muted.full', 'An admin can change these.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api('/reports/costs/settings', { method: 'PUT', body: { usd_to_aud: rate.value || null, sms_price_per_part: part.value || null } });
      toast('Saved');
      onSaved();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  return form;
}

async function costsReport() {
  const r = await api(`/reports/costs?${new URLSearchParams(periodQuery())}`);
  const s = r.settings;
  const t = r.totals;
  const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
  const tile = (l, v, sub) => h('div.tile', h('div.tile-label', l), h('div.tile-value', v), sub ? h('div.tile-sub', sub) : null);
  const both = (k) => (t[`${k}_total_aud`] !== null ? aud(t[`${k}_total_aud`], true) : `${usd(t[`${k}_ai_usd`])} + ${money2(t[`${k}_sms_aud`])}`);
  const split = (k) => `Claude ${s.usd_to_aud ? `${aud(t[`${k}_ai_aud`], true)} (${usd(t[`${k}_ai_usd`])})` : usd(t[`${k}_ai_usd`])} · SMS ${money2(t[`${k}_sms_aud`])} (${t[`${k}_sms_count`]} text${t[`${k}_sms_count`] === 1 ? '' : 's'})`;
  const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'short', year: r.months.length > 12 ? '2-digit' : undefined });
  const chart = s.usd_to_aud
    ? stackedColumns(r.months.map((m) => ({ label: monthLabel(m.month), parts: [m.ai_aud, m.sms_aud], tip: `${m.month}: Claude ${aud(m.ai_aud, true)}, SMS ${money2(m.sms_aud)}` })), { names: ['Claude (Anthropic)', 'SMS'], format: money2, empty: 'No costs in this period yet.' })
    : h('div.grid-2',
      h('div', h('h3', 'Claude (US$)'), columns(r.months.map((m) => ({ label: monthLabel(m.month), value: m.ai_usd, tip: usd(m.ai_usd) })), { format: usd, empty: 'No Claude usage in this period yet.' })),
      h('div', h('h3', 'SMS (A$)'), columns(r.months.map((m) => ({ label: monthLabel(m.month), value: m.sms_aud, tip: money2(m.sms_aud) })), { format: money2, empty: 'No texts sent in this period yet.' })));
  return h('div',
    pageHeader('Reports', await periodPicker(r.period)),
    tabs('costs'),
    !s.usd_to_aud ? h('div.alert.info', h('strong', 'Tip: '), 'add a US$ → A$ exchange rate below to see Claude and SMS costs together in Australian dollars.') : null,
    r.notes.sms_unpriced ? h('div.alert.warn-box', `${r.notes.sms_unpriced} text${r.notes.sms_unpriced === 1 ? '' : 's'} in this period ha${r.notes.sms_unpriced === 1 ? 's' : 've'} no price from ClickSend. Add your price per SMS part below to include ${r.notes.sms_unpriced === 1 ? 'it' : 'them'}.`) : null,
    h('div.tiles',
      tile('This month', both('month'), split('month')),
      tile(r.period.label, both('period'), split('period')),
      tile('Running total', both('all'), `${split('all')}${t.since ? ` · since ${date(t.since)}` : ''}`)),
    h('section.card', h('h2', `Costs by month – ${r.period.label}`), chart),
    h('section.card', h('h2', 'Month by month'), h('p.small.muted', 'Most recent first. The running total adds up each month from the start of the period.'),
      table([
        { label: 'Month', value: (m) => new Date(`${m.month}-01T00:00:00`).toLocaleString('en-AU', { month: 'long', year: 'numeric' }) },
        { label: 'Claude requests', value: (m) => String(m.ai_requests), class: 'num' },
        { label: 'Claude (US$)', value: (m) => `${m.ai_estimated ? '≈ ' : ''}${usd(m.ai_usd)}`, class: 'num' },
        s.usd_to_aud ? { label: 'Claude (A$)', value: (m) => aud(m.ai_aud, true), class: 'num' } : null,
        { label: 'Texts', value: (m) => `${m.sms_count}${m.sms_parts > m.sms_count ? ` (${m.sms_parts} parts)` : ''}`, class: 'num' },
        { label: 'SMS (A$)', value: (m) => `${m.sms_estimated ? '≈ ' : ''}${money2(m.sms_aud)}${m.sms_unpriced ? ' +?' : ''}`, class: 'num' },
        s.usd_to_aud ? { label: 'Month total (A$)', value: (m) => h('strong', aud(m.total_aud, true)), class: 'num' } : null,
        { label: 'Running total', value: (m) => (s.usd_to_aud ? aud(m.running_aud, true) : usd(m.running_usd)), class: 'num' },
      ].filter(Boolean), r.months.filter((m) => m.month <= new Date().toISOString().slice(0, 7)).reverse(), { empty: 'No months in this period yet.' })),
    h('div.grid-2',
      h('section.card', h('h2', 'Claude by feature'),
        table([
          { label: 'Feature', value: (f) => f.label },
          { label: 'Requests', value: (f) => String(f.requests), class: 'num' },
          { label: 'Web searches', value: (f) => String(f.searches), class: 'num' },
          { label: 'Tokens in / out', value: (f) => `${Math.round(f.tokens_in / 1000).toLocaleString('en-AU')}k / ${Math.round(f.tokens_out / 1000).toLocaleString('en-AU')}k`, class: 'num' },
          { label: s.usd_to_aud ? 'Cost' : 'Cost (US$)', value: (f) => (s.usd_to_aud ? [h('div', aud(f.aud, true)), h('div.small.muted', usd(f.usd))] : usd(f.usd)), class: 'num' },
        ], r.by_feature, { empty: 'No Claude usage in this period.' })),
      h('section.card', h('h2', 'SMS by sender'),
        table([
          { label: 'Sent by', value: (x) => x.name },
          { label: 'Texts', value: (x) => String(x.count), class: 'num' },
          { label: 'Parts', value: (x) => String(x.parts), class: 'num' },
          { label: 'Cost (A$)', value: (x) => money2(x.aud), class: 'num' },
        ], r.sms_by_sender, { empty: 'No texts sent in this period.' }))),
    h('section.card', h('h2', 'Settings'), costSettingsForm(s, refresh)),
    h('p.small.muted', 'Claude costs are worked out from each request\'s usage at Anthropic\'s list prices for the model that answered (plus US$10 per 1,000 web searches), so your invoice may differ slightly (GST, credits, rounding). ≈ marks estimates, including converted amounts and usage from before this report existed. SMS costs use the price ClickSend reports for each text when it does; logged texts (ClickSend not connected) cost nothing. For exact figures, check the Anthropic Console (Billing) and your ClickSend dashboard.'));
}
