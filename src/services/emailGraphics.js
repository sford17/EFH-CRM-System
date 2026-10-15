'use strict';
// Charts and diagrams that can be dropped into an email template on a line of
// their own, e.g. [[progress]] or [[button: Book a time | https://…]].
//
// They're built from HTML tables with inline styles (no SVG, no scripts), the
// one approach every email client renders, including Outlook. That also means
// they show even when the client's email program blocks downloaded images.
// Each one also has a plain-text version for the text part of the email.
const db = require('../db');
const { money, formatDate, today, daysBetween } = require('../util');

const FONT = 'Arial, Helvetica, sans-serif';
const BORDER = '#e3e7ec';
const MUTED = '#5f6b7a';
const TEXT = '#1f2933';

const GRAPHICS = [
  { key: 'progress', label: 'Loan progress tracker', needs: 'deal', hint: 'Where the loan is up to, from fact find to settled' },
  { key: 'loan_summary', label: 'Loan details card', needs: 'deal', hint: 'Lender (with logo), amount, rate, property and LVR' },
  { key: 'key_dates', label: 'Key dates', needs: 'deal', hint: 'Pre-approval expiry, finance due date and settlement, with days to go' },
  { key: 'documents', label: 'Document checklist', needs: 'deal', hint: 'Documents still needed and those already received' },
  { key: 'position', label: 'Position summary', needs: 'contact', hint: 'Property value, total lending, LVR and usable equity, from the mortgage tracker' },
  { key: 'lending_structure', label: 'Lending structure diagram', needs: 'contact', hint: 'Each lender and loan, the property securing it, and each property\'s LVR' },
  { key: 'equity_chart', label: 'Equity chart', needs: 'contact', hint: 'Bar chart of each property\'s value split into loan and equity' },
  { key: 'value_history', label: 'Property value chart', needs: 'contact', hint: 'Bar chart of the main property\'s valuations over time' },
  { key: 'fixed_rate', label: 'Fixed rate countdown', needs: 'loan', hint: 'Days until the fixed rate ends, with the loan details' },
  { key: 'button', label: 'Button', needs: null, hint: 'A button in your brand colour, e.g. [[button: Book a time | {{broker.booking_link}}]]' },
  { key: 'image', label: 'Image', needs: null, hint: 'A picture you upload, e.g. a banner or your own diagram' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const compact = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : money(n));
const pct = (n, dp = 1) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(dp).replace(/\.0+$/, '')}%`);
const LOAN_LABELS = { home_loan: 'Home loan', investment_loan: 'Investment loan', line_of_credit: 'Line of credit', credit_card: 'Credit card', hecs: 'HECS-HELP', construction: 'Construction loan', personal: 'Personal loan', car: 'Car loan', bridging: 'Bridging loan', commercial: 'Commercial loan' };
const loanLabel = (t) => LOAN_LABELS[t] || 'Loan';
const shortAddress = (a) => String(a || '').split(',')[0];
const rateText = (l) => (l.interest_rate ? `${pct(l.interest_rate, 2)} ${l.rate_type === 'fixed' ? 'fixed' : l.rate_type === 'split' ? 'split' : 'variable'}` : '');
const lvrColour = (lvr, c) => (lvr > 90 ? '#c0392b' : lvr > 80 ? '#c27c0e' : c.primary);

// A line that is only a graphic tag, e.g. "[[progress]]" or "[[button: Label | url]]".
function parseTag(text) {
  const m = /^\[\[\s*([a-z_]+)\s*(?::\s*([\s\S]*?))?\s*\]\]$/i.exec(String(text).trim());
  if (!m) return null;
  const key = m[1].toLowerCase();
  if (!GRAPHICS.some((g) => g.key === key)) return null;
  return { key, args: (m[2] || '').split('|').map((s) => s.trim()) };
}

// ---- Building blocks ---------------------------------------------------------------

const card = (c, title, inner) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px 0;border:1px solid ${BORDER};border-radius:8px;border-collapse:separate;">
<tr><td style="padding:16px 18px;font-family:${FONT};color:${TEXT};">
${title ? `<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;color:${c.link};margin:0 0 12px 0;">${esc(title)}</div>` : ''}${inner}
</td></tr></table>`;

// Horizontal bar: `parts` are [fraction 0–1, colour], drawn left to right.
function bar(parts, height = 10) {
  const cells = parts.filter(([f]) => f > 0.001).map(([f, colour]) => `<td width="${Math.max(1, Math.round(f * 100))}%" bgcolor="${colour}" style="background:${colour};height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</td>`);
  const used = parts.reduce((s, [f]) => s + Math.max(0, f), 0);
  if (used < 0.999) cells.push(`<td width="${Math.round((1 - used) * 100)}%" bgcolor="#eef1f4" style="background:#eef1f4;height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</td>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:${height / 2}px;overflow:hidden;"><tr>${cells.join('')}</tr></table>`;
}

const rows = (pairs) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pairs.filter(Boolean).map(([k, v]) => `<tr>
<td valign="top" style="padding:6px 12px 6px 0;font-size:13px;color:${MUTED};width:40%;border-bottom:1px solid #f0f2f5;">${esc(k)}</td>
<td valign="top" style="padding:6px 0;font-size:14px;color:${TEXT};font-weight:bold;border-bottom:1px solid #f0f2f5;">${v}</td></tr>`).join('')}</table>`;

const logoImg = (assetId, name, maxW = 110, maxH = 28) => {
  if (!assetId) return '';
  const a = db.one('SELECT id, width, height FROM assets WHERE id = ?', assetId);
  if (!a) return '';
  const scale = Math.min(1, maxW / a.width, maxH / a.height);
  const w = Math.max(1, Math.round(a.width * scale));
  const hgt = Math.max(1, Math.round(a.height * scale));
  return `<img src="/assets/${a.id}" width="${w}" height="${hgt}" alt="${esc(name)}" style="border:0;width:${w}px;height:${hgt}px;vertical-align:middle;">`;
};

// Two or more stat tiles per row.
function tiles(items, c, perRow = 2) {
  const out = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    out.push(`<tr>${row.map(([label, value, sub]) => `<td width="${Math.floor(100 / perRow)}%" valign="top" style="padding:4px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${c.soft}" style="background:${c.soft};border-radius:6px;padding:12px 14px;font-family:${FONT};">
<div style="font-size:12px;color:${MUTED};">${esc(label)}</div>
<div style="font-size:20px;font-weight:bold;color:${c.dark};margin-top:2px;">${esc(value)}</div>
${sub ? `<div style="font-size:12px;color:${MUTED};margin-top:2px;">${esc(sub)}</div>` : ''}
</td></tr></table></td>`).join('')}${row.length < perRow ? `<td width="${Math.floor(100 / perRow) * (perRow - row.length)}%" colspan="${perRow - row.length}"></td>` : ''}</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:-4px;">${out.join('')}</table>`;
}

// ---- Data ------------------------------------------------------------------------------

function loadDeal(dealId) {
  if (!dealId) return null;
  return db.one(
    `SELECT d.*, l.name AS lender_name, l.logo_asset_id AS lender_logo_id FROM deals d LEFT JOIN lenders l ON l.id = d.lender_id WHERE d.id = ?`,
    dealId,
  );
}

function loadLoan({ loanId, dealId, contactId }) {
  const select = `SELECT n.*, COALESCE(l.name, n.lender_name) AS lender_name, l.logo_asset_id AS lender_logo_id FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id`;
  if (loanId) return db.one(`${select} WHERE n.id = ?`, loanId);
  const byDeal = dealId ? db.one(`${select} WHERE n.deal_id = ?`, dealId) : null;
  if (byDeal) return byDeal;
  if (!contactId) return null;
  return db.one(
    `${select} WHERE (n.contact_id = ? OR n.id IN (SELECT loan_id FROM loan_borrowers WHERE contact_id = ?)) AND n.status = 'active' AND n.fixed_expiry_date >= ?
     ORDER BY n.fixed_expiry_date LIMIT 1`,
    contactId, contactId, today(),
  );
}

// Lazily loads what the graphics in one email need.
function dataSource({ contactId = null, dealId = null, loanId = null, sample = false, internal = false } = {}) {
  const cache = {};
  const once = (k, fn) => (k in cache ? cache[k] : (cache[k] = fn()));
  if (sample) return SAMPLE;
  return {
    internal,
    deal: () => once('deal', () => loadDeal(dealId)),
    documents: () => once('docs', () => (dealId ? db.all('SELECT name, status FROM documents WHERE deal_id = ? ORDER BY category, name', dealId) : [])),
    summary: () => once('summary', () => {
      const id = contactId || loadDeal(dealId)?.contact_id;
      return id ? require('./tracker').summary(id) : null;
    }),
    loan: () => once('loan', () => loadLoan({ loanId, dealId, contactId })),
  };
}

// ---- The graphics ---------------------------------------------------------------------------

const STEPS = [
  ['fact_find', 'Fact find'], ['pre_approval', 'Pre-approval'], ['application_lodged', 'Lodged'],
  ['conditional_approval', 'Conditional'], ['unconditional_approval', 'Approved'], ['settlement_booked', 'Settlement booked'], ['settled', 'Settled'],
];

const RENDER = {
  progress(src, c) {
    const d = src.deal();
    if (!d || d.stage === 'lost') return null;
    const at = STEPS.findIndex(([k]) => k === d.stage);
    const segs = STEPS.map((_, i) => `<td width="${(100 / STEPS.length).toFixed(2)}%" style="padding:0 2px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${i <= at ? c.primary : '#e3e7ec'}" style="background:${i <= at ? c.primary : '#e3e7ec'};height:8px;line-height:8px;font-size:1px;border-radius:4px;">&nbsp;</td></tr></table></td>`);
    const labels = STEPS.map(([, label], i) => `<td valign="top" align="center" style="padding:6px 2px 0 2px;font-size:11px;line-height:14px;font-family:${FONT};color:${i === at ? c.dark : i < at ? TEXT : '#9aa5b1'};${i === at ? 'font-weight:bold;' : ''}">${i < at ? '&#10003; ' : ''}${esc(label)}</td>`);
    const current = at >= 0 ? STEPS[at][1] : 'Getting started';
    const next = STEPS[at + 1]?.[1];
    // The step names are hidden on phones (class efh-hide-sm), where they'd
    // be squashed; the "Current stage / Next" line says the same thing.
    const html = card(c, 'Your loan progress', `<div style="font-size:15px;margin:0 0 12px 0;">Current stage: <strong style="color:${c.dark};">${esc(current)}</strong>${at >= 0 ? ` <span style="color:${MUTED};font-size:13px;">(step ${at + 1} of ${STEPS.length})</span>` : ''}${next ? `<br><span style="color:${MUTED};font-size:13px;">Next: ${esc(next)}</span>` : ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr>${segs.join('')}</tr><tr class="efh-hide-sm">${labels.join('')}</tr></table>`);
    const text = `Your loan progress: ${current}${at >= 0 ? ` (step ${at + 1} of ${STEPS.length})` : ''}\n${STEPS.map(([, l], i) => `${i < at ? '[x]' : i === at ? '[>]' : '[ ]'} ${l}`).join('\n')}`;
    return { html, text };
  },

  loan_summary(src, c) {
    const d = src.deal();
    if (!d) return null;
    const lvr = d.loan_amount && d.property_value ? Math.round((d.loan_amount / d.property_value) * 1000) / 10 : null;
    const pairs = [
      d.lender_name ? ['Lender', `${logoImg(d.lender_logo_id, d.lender_name)}${d.lender_logo_id ? '&nbsp; ' : ''}${esc(d.lender_name)}`] : null,
      d.loan_amount ? ['Loan amount', esc(money(d.loan_amount))] : null,
      d.interest_rate ? ['Interest rate', esc(`${rateText(d)}${d.rate_type === 'fixed' && d.fixed_expiry_date ? ` until ${formatDate(d.fixed_expiry_date)}` : ''}`)] : null,
      d.product_name ? ['Product', esc(d.product_name)] : null,
      d.property_address ? ['Property', esc(d.property_address)] : null,
      d.property_value ? ['Property value', esc(money(d.property_value))] : null,
      lvr ? ['Loan to value (LVR)', `${pct(lvr)}<div style="margin-top:6px;">${bar([[Math.min(1, lvr / 100), lvrColour(lvr, c)]], 8)}</div>`] : null,
      d.settlement_date ? [d.stage === 'settled' ? 'Settled' : 'Settlement', esc(formatDate(d.settlement_date))] : null,
    ].filter(Boolean);
    if (!pairs.length) return null;
    const text = `Your loan\n${pairs.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()}`).join('\n')}`;
    return { html: card(c, 'Your loan', rows(pairs)), text };
  },

  key_dates(src, c) {
    const d = src.deal();
    if (!d) return null;
    const now = today();
    const items = [
      ['Pre-approval expires', d.pre_approval_expiry],
      ['Finance due', d.finance_due_date],
      ['Settlement', d.settlement_date],
      ...(d.rate_type === 'fixed' && d.fixed_expiry_date ? [['Fixed rate ends', d.fixed_expiry_date]] : []),
    ].filter(([, date]) => date).sort((a, b) => a[1].localeCompare(b[1]));
    if (!items.length) return null;
    const away = (date) => {
      const n = daysBetween(now, date);
      return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n > 0 ? `In ${n} days` : `${-n} days ago`;
    };
    const html = card(c, 'Key dates', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items.map(([label, date]) => {
      const past = date < now;
      return `<tr>
<td width="14" valign="top" style="padding:9px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${past ? '#c5ccd4' : c.primary}" style="background:${past ? '#c5ccd4' : c.primary};width:10px;height:10px;line-height:10px;font-size:1px;border-radius:5px;">&nbsp;</td></tr></table></td>
<td style="padding:6px 0 6px 10px;font-size:14px;border-bottom:1px solid #f0f2f5;"><strong>${esc(label)}</strong><br><span style="color:${MUTED};font-size:13px;">${esc(formatDate(date))}</span></td>
<td align="right" style="padding:6px 0;font-size:13px;font-weight:bold;color:${past ? MUTED : c.dark};border-bottom:1px solid #f0f2f5;white-space:nowrap;">${esc(away(date))}</td></tr>`;
    }).join('')}</table>`);
    return { html, text: `Key dates\n${items.map(([l, date]) => `${l}: ${formatDate(date)} (${away(date).toLowerCase()})`).join('\n')}` };
  },

  documents(src, c) {
    const docs = src.documents().filter((x) => x.status !== 'not_applicable');
    if (!docs.length) return null;
    const outstanding = docs.filter((x) => ['required', 'requested'].includes(x.status));
    const received = docs.filter((x) => ['received', 'verified'].includes(x.status));
    const item = (x, done) => `<tr><td width="22" valign="top" style="padding:5px 0;font-size:14px;color:${done ? '#1e8e4e' : c.link};font-weight:bold;">${done ? '&#10003;' : '&#9744;'}</td>
<td style="padding:5px 0;font-size:14px;color:${done ? MUTED : TEXT};">${esc(x.name)}</td></tr>`;
    const progress = received.length / (outstanding.length + received.length || 1);
    const html = card(c, 'Your documents', `<div style="font-size:14px;margin-bottom:8px;"><strong>${received.length} of ${outstanding.length + received.length}</strong> received</div>
${bar([[progress, c.primary]], 8)}
${outstanding.length ? `<div style="font-size:13px;font-weight:bold;margin:14px 0 4px 0;">Still needed</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${outstanding.map((x) => item(x, false)).join('')}</table>` : ''}
${received.length ? `<div style="font-size:13px;font-weight:bold;margin:14px 0 4px 0;color:${MUTED};">Received – thank you</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${received.map((x) => item(x, true)).join('')}</table>` : ''}`);
    const text = `Your documents: ${received.length} of ${outstanding.length + received.length} received\n${outstanding.length ? `Still needed:\n${outstanding.map((x) => `  - ${x.name}`).join('\n')}\n` : ''}${received.length ? `Received:\n${received.map((x) => `  - ${x.name}`).join('\n')}` : ''}`;
    return { html, text: text.trim() };
  },

  position(src, c) {
    const s = src.summary();
    if (!s || (!s.structure.properties.length && !s.loans.length)) return null;
    const t = s.totals;
    const items = [
      ['Property value', compact(t.property_value), `${s.structure.properties.length} propert${s.structure.properties.length === 1 ? 'y' : 'ies'}`],
      ['Total lending', compact(t.total_debt), `${s.loans.filter((n) => n.status === 'active').length} active loan${s.loans.filter((n) => n.status === 'active').length === 1 ? '' : 's'}`],
      ['Loan to value (LVR)', pct(t.lvr), t.lvr > 80 ? 'Above 80%' : t.lvr === null ? null : 'At or below 80%'],
      ['Usable equity', compact(t.usable_equity), 'borrowing to 80%'],
    ];
    return {
      html: card(c, 'Your position at a glance', tiles(items, c)),
      text: `Your position at a glance\n${items.map(([l, v]) => `${l}: ${v}`).join('\n')}`,
    };
  },

  lending_structure(src, c) {
    const s = src.summary();
    if (!s || !s.structure.lenders.length) return null;
    const props = new Map(s.structure.properties.map((p) => [p.id, p]));
    const lenderBlocks = s.structure.lenders.map((l) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;border:1px solid ${BORDER};border-radius:6px;border-collapse:separate;">
<tr><td bgcolor="${c.soft}" style="background:${c.soft};padding:8px 12px;border-radius:6px 6px 0 0;font-size:14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-weight:bold;color:${c.dark};">${logoImg(l.logo_id, l.name, 90, 22)}${l.logo_id ? '&nbsp; ' : ''}${esc(l.name)}</td><td align="right" style="font-weight:bold;color:${c.dark};">${esc(compact(l.total))}</td></tr></table></td></tr>
${l.loans.map((n) => {
    const secured = n.security_ids.map((id) => props.get(id)).filter(Boolean).map((p) => shortAddress(p.address));
    return `<tr><td style="padding:8px 12px;border-top:1px solid #f0f2f5;font-size:14px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td><strong>${esc(loanLabel(n.loan_type))}</strong> <span style="color:${MUTED};font-size:13px;">${esc([rateText(n), n.repayment_type === 'io' ? 'interest only' : null].filter(Boolean).join(' · '))}</span><br>
<span style="font-size:12px;color:${MUTED};">${secured.length ? `&#8627; Secured by ${esc(secured.join(' + '))}${secured.length > 1 ? ' <span style="color:#c27c0e;font-weight:bold;">(cross-secured)</span>' : ''}` : 'Unsecured'}</span></td>
<td align="right" valign="top" style="font-weight:bold;white-space:nowrap;">${esc(compact(n.owing))}</td></tr></table></td></tr>`;
  }).join('')}</table>`).join('');
    const propBlocks = s.structure.properties.map((p) => `<tr><td style="padding:8px 0;border-bottom:1px solid #f0f2f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:14px;font-weight:bold;">${esc(shortAddress(p.address))}</td><td align="right" style="font-size:13px;color:${MUTED};">Value ${esc(compact(p.current_value || 0))}</td></tr></table>
<div style="margin:6px 0 4px 0;">${bar([[Math.min(1, (p.lvr || 0) / 100), lvrColour(p.lvr, c)]], 8)}</div>
<div style="font-size:12px;color:${MUTED};">LVR <strong style="color:${lvrColour(p.lvr, c)};">${pct(p.lvr)}</strong> · owing ${esc(compact(p.secured_debt))} · usable equity ${esc(compact(p.usable_equity || 0))}</div></td></tr>`).join('');
    const html = card(c, 'How your lending is structured', `${lenderBlocks}
${propBlocks ? `<div style="font-size:13px;font-weight:bold;margin:12px 0 2px 0;">Your properties</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${propBlocks}</table>` : ''}`);
    const text = ['How your lending is structured',
      ...s.structure.lenders.flatMap((l) => [`${l.name} – ${compact(l.total)}`, ...l.loans.map((n) => `  - ${loanLabel(n.loan_type)} ${compact(n.owing)}${rateText(n) ? ` at ${rateText(n)}` : ''}, ${n.security_ids.length ? `secured by ${n.security_ids.map((id) => shortAddress(props.get(id)?.address)).join(' + ')}` : 'unsecured'}`)]),
      ...s.structure.properties.map((p) => `${shortAddress(p.address)}: value ${compact(p.current_value || 0)}, LVR ${pct(p.lvr)}`)].join('\n');
    return { html, text };
  },

  equity_chart(src, c) {
    const s = src.summary();
    const props = (s?.structure.properties || []).filter((p) => p.current_value);
    if (!props.length) return null;
    const max = Math.max(...props.map((p) => p.current_value));
    const debtColour = c.dark;
    const equityColour = c.tint;
    const html = card(c, 'Your property equity', `${props.map((p) => {
      const scale = p.current_value / max;
      const debt = Math.min(p.secured_debt, p.current_value) / max;
      return `<div style="font-size:13px;margin:10px 0 4px 0;"><strong>${esc(shortAddress(p.address))}</strong> <span style="color:${MUTED};">${esc(compact(p.current_value))}</span></div>
${bar([[debt, debtColour], [Math.max(0, scale - debt), equityColour]], 18)}
<div style="font-size:12px;color:${MUTED};margin-top:3px;">Loan ${esc(compact(p.secured_debt))} · Equity ${esc(compact(Math.max(0, p.equity || 0)))}</div>`;
    }).join('')}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr>
<td bgcolor="${debtColour}" style="background:${debtColour};width:12px;height:12px;font-size:1px;">&nbsp;</td><td style="font-size:12px;color:${MUTED};padding:0 14px 0 6px;">Owing</td>
<td bgcolor="${equityColour}" style="background:${equityColour};width:12px;height:12px;font-size:1px;">&nbsp;</td><td style="font-size:12px;color:${MUTED};padding:0 0 0 6px;">Your equity</td></tr></table>`);
    return { html, text: `Your property equity\n${props.map((p) => `${shortAddress(p.address)}: value ${compact(p.current_value)}, loan ${compact(p.secured_debt)}, equity ${compact(Math.max(0, p.equity || 0))}`).join('\n')}` };
  },

  value_history(src, c) {
    const s = src.summary();
    const prop = (s?.properties || []).filter((p) => p.status !== 'sold' && p.valuations.length >= 2)
      .sort((a, b) => (b.current_value || 0) - (a.current_value || 0))[0];
    if (!prop) return null;
    const vals = [...prop.valuations].sort((a, b) => a.valuation_date.localeCompare(b.valuation_date)).slice(-6);
    const max = Math.max(...vals.map((v) => v.amount));
    const min = Math.min(...vals.map((v) => v.amount));
    const floor = Math.max(0, min - (max - min) * 1.5); // so differences are visible
    const H = 120;
    const cols = vals.map((v, i) => {
      const hgt = Math.max(6, Math.round(((v.amount - floor) / (max - floor || 1)) * H));
      const colour = i === vals.length - 1 ? c.primary : c.tint;
      return `<td valign="bottom" align="center" style="padding:0 4px;"><div style="font-size:11px;font-weight:bold;color:${c.dark};margin-bottom:3px;">${esc(compact(v.amount))}</div>
<table role="presentation" width="70%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${colour}" height="${hgt}" style="background:${colour};height:${hgt}px;line-height:${hgt}px;font-size:1px;border-radius:3px 3px 0 0;">&nbsp;</td></tr></table></td>`;
    });
    const labels = vals.map((v) => `<td align="center" valign="top" style="padding:5px 2px 0 2px;font-size:11px;color:${MUTED};border-top:1px solid ${BORDER};">${esc(new Date(`${v.valuation_date}T00:00:00Z`).toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' }))}<br>${esc(v.method_label)}</td>`);
    const first = vals[0];
    const last = vals[vals.length - 1];
    const growth = first.amount ? Math.round(((last.amount - first.amount) / first.amount) * 1000) / 10 : null;
    const html = card(c, `${shortAddress(prop.address)}: estimated value`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr>${cols.join('')}</tr><tr>${labels.join('')}</tr></table>
${growth !== null ? `<div style="font-size:13px;margin-top:10px;">${growth >= 0 ? 'Up' : 'Down'} <strong style="color:${growth >= 0 ? '#1e8e4e' : '#c0392b'};">${pct(Math.abs(growth))}</strong> since ${esc(formatDate(first.valuation_date))}.</div>` : ''}`);
    return { html, text: `${shortAddress(prop.address)}: estimated value\n${vals.map((v) => `${formatDate(v.valuation_date)}: ${money(v.amount)} (${v.method_label})`).join('\n')}` };
  },

  fixed_rate(src, c) {
    const n = src.loan();
    if (!n?.fixed_expiry_date) return null;
    const days = daysBetween(today(), n.fixed_expiry_date);
    if (days < 0) return null;
    const start = n.settlement_date && n.settlement_date < n.fixed_expiry_date ? n.settlement_date : null;
    const elapsed = start ? Math.min(1, Math.max(0, daysBetween(start, today()) / Math.max(1, daysBetween(start, n.fixed_expiry_date)))) : null;
    const owing = n.balance ?? n.limit_amount;
    const html = card(c, 'Your fixed rate', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="120" valign="middle" align="center" bgcolor="${c.primary}" style="background:${c.primary};border-radius:8px;padding:12px 6px;color:${c.onPrimary};font-family:${FONT};">
<div style="font-size:30px;font-weight:bold;line-height:32px;">${days}</div><div style="font-size:12px;">day${days === 1 ? '' : 's'} to go</div></td>
<td valign="middle" style="padding-left:16px;font-size:14px;">
<div>Fixed rate ends <strong>${esc(formatDate(n.fixed_expiry_date))}</strong></div>
<div style="color:${MUTED};font-size:13px;margin-top:4px;">${esc([n.lender_name, loanLabel(n.loan_type).toLowerCase(), owing ? compact(owing) : null, n.interest_rate ? `${pct(n.interest_rate, 2)} fixed` : null].filter(Boolean).join(' · '))}</div>
${elapsed !== null ? `<div style="margin-top:10px;">${bar([[elapsed, c.primary]], 8)}</div><div style="font-size:11px;color:${MUTED};margin-top:3px;">${Math.round(elapsed * 100)}% of the fixed term has passed</div>` : ''}
</td></tr></table>`);
    return { html, text: `Your fixed rate ends on ${formatDate(n.fixed_expiry_date)} – ${days} day${days === 1 ? '' : 's'} to go.` };
  },

  button(src, c, args) {
    const [label = 'Find out more', raw = ''] = args;
    // A bare domain (e.g. a website setting of "efh.com.au") gets https://.
    const url = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw) ? `https://${raw}` : raw;
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(url)) return null;
    const html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px 0;"><tr>
<td bgcolor="${c.button}" style="background:${c.button};border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:bold;color:${c.onButton};text-decoration:none;border-radius:6px;">${esc(label)}</a></td></tr></table>`;
    return { html, text: `${label}: ${url}` };
  },

  image(src, c, args) {
    const id = Number(args[0]);
    const a = id ? db.one("SELECT id, width, height FROM assets WHERE id = ? AND kind = 'email_image'", id) : null;
    if (!a) return null;
    const w = Math.min(536, a.width);
    const hgt = Math.round(a.height * (w / a.width));
    const alt = args[1] || '';
    return {
      html: `<div style="margin:4px 0 18px 0;"><img src="/assets/${a.id}" width="${w}" alt="${esc(alt)}" style="display:block;border:0;width:100%;max-width:${w}px;height:auto;border-radius:6px;" height="${hgt}"></div>`,
      text: alt ? `[${alt}]` : '',
    };
  },
};

// Renders one tag. Returns { html, text }, or null when there's nothing to
// show (e.g. a deal graphic on an email that isn't about a deal).
// Headings are written to the client ("Your loan"); emails to the broker
// (reminders) use neutral wording instead.
const BROKER_WORDING = [
  ['Your loan progress', 'Loan progress'], ['Your loan', 'Loan'], ['Your documents', 'Documents'],
  ['Your position at a glance', 'Position at a glance'], ['How your lending is structured', 'Lending structure'],
  ['Your properties', 'Properties'], ['Your property equity', 'Property equity'], ['Your equity', 'Equity'],
  ['Your fixed rate ends on', 'The fixed rate ends on'], ['Your fixed rate', 'Fixed rate'], ['Received – thank you', 'Received'],
];

function render(tag, src, colours) {
  try {
    const out = RENDER[tag.key](src, colours, tag.args) || null;
    if (out && src.internal) {
      for (const [from, to] of BROKER_WORDING) {
        out.html = out.html.split(`>${from}`).join(`>${to}`);
        out.text = out.text.split(from).join(to);
      }
    }
    return out;
  } catch (err) {
    return null;
  }
}

// ---- Example data for previews (Email templates page) ---------------------------------------------

const addD = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addY = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + Math.round(n * 12)); return d.toISOString().slice(0, 10); };
const SAMPLE_DEAL = {
  stage: 'conditional_approval', lender_name: 'Westpac', lender_logo_id: null, loan_amount: 640000, property_value: 800000,
  interest_rate: 5.89, rate_type: 'variable', product_name: 'Flexi First Option', property_address: '8 Sample St, Newtown NSW 2042',
  pre_approval_expiry: addD(40), finance_due_date: addD(6), settlement_date: addD(34), contact_id: null,
};
const SAMPLE_PROPS = [
  { id: 1, address: '8 Sample St, Newtown NSW', current_value: 1185000, secured_debt: 760000, lvr: 64.1, equity: 425000, usable_equity: 188000 },
  { id: 2, address: '12/45 Example Rd, Enmore NSW', current_value: 655000, secured_debt: 470000, lvr: 71.8, equity: 185000, usable_equity: 54000 },
];
const SAMPLE_SUMMARY = {
  loans: [{ status: 'active' }, { status: 'active' }],
  totals: { property_value: 1840000, total_debt: 1230000, lvr: 66.8, usable_equity: 242000 },
  structure: {
    properties: SAMPLE_PROPS,
    lenders: [
      { name: 'Westpac', logo_id: null, total: 760000, loans: [{ loan_type: 'home_loan', owing: 760000, interest_rate: 5.69, rate_type: 'fixed', security_ids: [1] }] },
      { name: 'ANZ', logo_id: null, total: 470000, loans: [{ loan_type: 'investment_loan', owing: 470000, interest_rate: 6.04, rate_type: 'variable', repayment_type: 'io', security_ids: [1, 2] }] },
    ],
  },
  properties: [{
    ...SAMPLE_PROPS[0], status: 'owned',
    valuations: [[-3, 950000, 'Contract price'], [-2, 1010000, 'Full valuation'], [-1.2, 1050000, 'Desktop valuation'], [-0.6, 1120000, 'AVM'], [-0.05, 1185000, 'AVM']]
      .map(([y, amount, method_label]) => ({ valuation_date: addY(y), amount, method_label })),
  }],
};
const SAMPLE = {
  deal: () => SAMPLE_DEAL,
  documents: () => [
    { name: 'Last 2 payslips', status: 'requested' }, { name: '3 months of bank statements', status: 'required' },
    { name: 'Photo ID (driver licence / passport)', status: 'verified' }, { name: 'Contract of sale', status: 'received' },
  ],
  summary: () => SAMPLE_SUMMARY,
  loan: () => ({ lender_name: 'Westpac', loan_type: 'home_loan', balance: 760000, interest_rate: 5.69, rate_type: 'fixed', fixed_expiry_date: addD(75), settlement_date: addY(-2.8) }),
};

// Merge-field values matching the example figures, for template previews.
function sampleMergeData() {
  const { stageLabel } = require('../util');
  return {
    contact: { first_name: 'Jane', last_name: 'Citizen', full_name: 'Jane Citizen', email: 'jane@example.com' },
    deal: {
      ...SAMPLE_DEAL, title: 'Jane Citizen – purchase', stage_label: stageLabel(SAMPLE_DEAL.stage), lvr: 80,
      outstanding_documents: SAMPLE.documents().filter((d) => ['required', 'requested'].includes(d.status)).map((d) => `  - ${d.name}`).join('\n'),
    },
    loan: SAMPLE.loan(),
    agent: { name: 'Sarah Lee', first_name: 'Sarah', company: 'Example Realty', email: 'sarah@example.com' },
    solicitor: { name: 'Tom Barker', first_name: 'Tom', company: 'Barker Conveyancing' },
    recipient: { name: 'Sarah Lee', first_name: 'Sarah' },
  };
}

module.exports = { GRAPHICS, parseTag, render, dataSource, sampleMergeData };
