'use strict';
// Client Lending Review documents. A review freezes a snapshot of the
// client's mortgage tracker, adds the broker's commentary, and renders the
// same document as HTML (preview), PDF and Word.
const db = require('../db');
const tracker = require('./tracker');
const branding = require('./branding');
const lenderLogos = require('./lenderLogos');

// Table cells are strings, or { text, logo } for a lender with its logo.
const cellText = (c) => (c && typeof c === 'object' ? c.text : String(c ?? ''));
const cellLogo = (c) => (c && typeof c === 'object' ? lenderLogos.logoData(c.logo) : null);
function fitBox(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
const { today, addMonths, formatDate, money: aud } = require('../util');

// ---- Snapshot & suggested commentary ----------------------------------------------

function snapshot(contactId, userId) {
  const contact = db.one('SELECT id, first_name, last_name, email, mobile, address, suburb, state, postcode FROM contacts WHERE id = ?', contactId);
  const broker = db.one('SELECT name, email, phone FROM users WHERE id = ?', userId) || {};
  const data = tracker.summary(contactId);
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const coBorrowers = [...new Set(data.loans.map((n) => n.co_borrower_name).filter(Boolean).map((s) => s.trim()))].filter((n) => n !== fullName);
  return {
    taken_at: new Date().toISOString(),
    contact: { ...contact, full_name: fullName },
    co_borrowers: coBorrowers,
    broker,
    business: {
      name: db.getSetting('business_name', ''),
      phone: db.getSetting('business_phone', ''),
      email: db.getSetting('business_email', ''),
      website: db.getSetting('business_website', ''),
      acl: db.getSetting('acl_number', ''),
    },
    ...data,
  };
}

const shortAddr = (a) => String(a || '').split(',')[0];
const loanName = (n) => `${n.lender_display} ${String(n.loan_type).replace(/_/g, ' ').replace('hecs', 'HECS')}`;
const d = (x) => (x ? formatDate(x) : '');

// Draft commentary from the numbers, for the broker to edit.
function suggestions(s, reviewDate = today()) {
  const active = s.loans.filter((n) => n.status === 'active');
  const t = s.totals;
  const lenders = new Set(active.map((n) => n.lender_display));
  const secured = active.filter((n) => n.security_ids.length);
  const soon = (date, months) => date && date >= reviewDate && date <= addMonths(reviewDate, months);

  const review = [];
  if (active.length) {
    review.push(`You have ${active.length} active loan${active.length === 1 ? '' : 's'} totalling ${aud(t.total_debt)} with ${lenders.size} lender${lenders.size === 1 ? '' : 's'}${secured.length ? `, secured by ${s.structure.properties.filter((p) => p.loan_ids.length).length} propert${s.structure.properties.filter((p) => p.loan_ids.length).length === 1 ? 'y' : 'ies'} valued at ${aud(t.property_value)} (overall LVR ${t.lvr ?? '–'}%)` : ''}.`);
    for (const n of active) {
      const rate = n.interest_rate ? ` at ${n.interest_rate}%` : '';
      const fixed = n.rate_type !== 'variable' && n.fixed_expiry_date ? ` ${n.rate_type} until ${d(n.fixed_expiry_date)}` : n.rate_type === 'variable' ? ' variable' : '';
      review.push(`• ${loanName(n)}: ${aud(n.owing)}${rate}${fixed}${n.repayment_type === 'io' ? ', interest only' : ''}.`);
    }
  } else {
    review.push('No loans are currently recorded.');
  }
  if (t.usable_equity > 0) review.push(`Based on current valuations there is approximately ${aud(t.usable_equity)} of usable equity (borrowing up to 80% of each property's value).`);

  const consider = [];
  const brokerTodo = [];
  for (const n of active) {
    if (n.rate_type !== 'variable' && soon(n.fixed_expiry_date, 6)) {
      consider.push(`• Your fixed rate on the ${loanName(n)} ends on ${d(n.fixed_expiry_date)}. Before it rolls to the lender's revert rate, compare re-fixing, moving to variable or refinancing.`);
      brokerTodo.push(`• Obtain re-fix and variable options from ${n.lender_display} ahead of ${d(n.fixed_expiry_date)}, and compare with other lenders.`);
    }
    if (n.repayment_type === 'io' && soon(n.io_expiry_date, 12)) {
      consider.push(`• The interest-only period on the ${loanName(n)} ends on ${d(n.io_expiry_date)}, after which repayments will increase. Options include extending interest only or moving to principal and interest.`);
      brokerTodo.push(`• Confirm post-interest-only repayments and extension options with ${n.lender_display}.`);
    }
    if (n.security_ids.length > 1) {
      consider.push(`• The ${loanName(n)} is secured by more than one property (cross-collateralised). Separating the securities can give more flexibility when selling or refinancing.`);
      brokerTodo.push(`• Model a restructure of the ${n.lender_display} securities into stand-alone loans.`);
    }
    if (['home_loan', 'investment_loan'].includes(n.loan_type) && n.rate_type === 'variable' && n.interest_rate >= 6.25) {
      consider.push(`• Your variable rate of ${n.interest_rate}% on the ${loanName(n)} may be above what new customers are offered.`);
      brokerTodo.push(`• Request a rate review (repricing) from ${n.lender_display}.`);
    }
    if (['credit_card', 'personal', 'car'].includes(n.loan_type) && n.owing > 0 && n.interest_rate >= 10) {
      consider.push(`• ${aud(n.owing)} on the ${loanName(n)} is costing ${n.interest_rate}%. Paying it down or consolidating it could save interest.`);
    }
  }
  for (const p of s.structure.properties) {
    if (p.lvr > 80) consider.push(`• ${shortAddr(p.address)} is at ${p.lvr}% LVR. Reducing debt below 80% can open up better rates and avoid mortgage insurance when refinancing.`);
    const v = p.current_valuation;
    if (p.loan_ids.length && (!v || v.valuation_date < addMonths(reviewDate, -12))) {
      brokerTodo.push(`• Order an updated valuation for ${shortAddr(p.address)}${v ? ` (last: ${v.method_label}, ${d(v.valuation_date)})` : ''}.`);
    }
  }
  if (t.usable_equity >= 50000) consider.push(`• You have around ${aud(t.usable_equity)} of usable equity that could support goals such as renovating, investing or consolidating debt.`);
  const savings = s.assets.filter((a) => a.asset_type === 'savings').reduce((x, a) => x + (a.value || 0), 0);
  if (savings > 5000 && !t.offsets && active.some((n) => ['home_loan', 'investment_loan'].includes(n.loan_type) && n.rate_type === 'variable')) {
    consider.push(`• Holding ${aud(savings)} in savings – an offset account on your home loan could reduce interest while keeping the money accessible.`);
  }

  return {
    loan_review: review.join('\n'),
    actions_to_consider: consider.join('\n') || '• No immediate changes needed – your lending looks well set up for now.',
    broker_to_action: brokerTodo.join('\n') || '• Keep monitoring rates and let you know if a better option appears.',
    next_steps: `• We'll be in touch to talk through these points.\n• Your next review is due around ${d(addMonths(reviewDate, 12))}.\n• Let us know in the meantime if your circumstances or plans change.`,
  };
}

// ---- Document model ---------------------------------------------------------------------
// Blocks: heading, text (commentary with bullets), tiles, table, diagram, note.

const pct = (n) => (n === null || n === undefined ? '–' : `${n}%`);
const typeLabel = (t) => ({ home_loan: 'Home loan', investment_loan: 'Investment loan', line_of_credit: 'Line of credit', credit_card: 'Credit card', hecs: 'HECS-HELP' }[t]
  || String(t).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
const titleCase = (t) => String(t || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function model(review) {
  const s = JSON.parse(review.snapshot);
  const t = s.totals;
  const active = s.loans.filter((n) => n.status === 'active');
  const propName = new Map(s.properties.map((p) => [p.id, shortAddr(p.address)]));
  const names = [s.contact.full_name, ...s.co_borrowers].join(' & ');
  const blocks = [];

  blocks.push({ type: 'tiles', items: [
    ['Property value', aud(t.property_value)],
    ['Total lending', aud(t.total_debt)],
    ['Overall LVR', pct(t.lvr)],
    ['Usable equity (80%)', aud(t.usable_equity)],
    ['Net position', aud(t.net_position)],
  ] });
  if (review.loan_review) blocks.push({ type: 'heading', text: 'Loan review' }, { type: 'text', text: review.loan_review });

  if (active.length) {
    blocks.push({ type: 'heading', text: 'Your loans' }, {
      type: 'table',
      widths: [1.4, 1.1, 1, 0.7, 1.3, 1.1, 1.4],
      columns: ['Lender', 'Loan', 'Balance', 'Rate', 'Rate type', 'Repayments', 'Secured by'],
      align: ['left', 'left', 'right', 'right', 'left', 'left', 'left'],
      rows: active.map((n) => [
        { text: `${n.lender_display}${n.account_number ? `\n${n.account_number}` : ''}`, logo: n.lender_logo_id },
        typeLabel(n.loan_type),
        `${aud(n.owing)}${n.offset_balance ? `\noffset ${aud(n.offset_balance)}` : ''}`,
        n.interest_rate ? `${n.interest_rate}%` : '–',
        n.rate_type === 'variable' ? 'Variable' : `${titleCase(n.rate_type)}${n.fixed_expiry_date ? ` to ${d(n.fixed_expiry_date)}` : ''}`,
        `${n.repayment_type === 'io' ? `Interest only${n.io_expiry_date ? ` to ${d(n.io_expiry_date)}` : ''}` : 'P&I'}${n.repayment_amount ? `\n${aud(n.repayment_amount)} ${n.repayment_frequency}` : ''}`,
        n.security_ids.length ? n.security_ids.map((id) => propName.get(id)).filter(Boolean).join(' + ') : 'Unsecured',
      ]),
      total: ['Total', '', aud(t.total_debt), '', '', '', ''],
    });
  }

  if (s.structure.properties.length) {
    blocks.push({ type: 'heading', text: 'Lending structure' });
    if (active.some((n) => n.security_ids.length)) blocks.push({ type: 'diagram', svg: structureSvg(s.structure) });
    blocks.push({
      type: 'table',
      widths: [2.2, 1.2, 1.6, 1.2, 0.8, 1.2],
      columns: ['Property', 'Value', 'Valuation', 'Secured lending', 'LVR', 'Usable equity'],
      align: ['left', 'right', 'left', 'right', 'right', 'right'],
      rows: s.structure.properties.map((p) => [
        `${p.address}\n${titleCase(p.usage)}`,
        aud(p.current_value),
        p.current_valuation ? `${p.current_valuation.method_label}\n${d(p.current_valuation.valuation_date)}` : 'No valuation',
        aud(p.secured_debt),
        pct(p.lvr),
        aud(p.usable_equity),
      ]),
    });
    const vals = [];
    for (const p of s.properties.filter((x) => x.status !== 'sold')) {
      for (const v of p.latest_by_method) vals.push([shortAddr(p.address), v.method_label, d(v.valuation_date), v.provider || '–', aud(v.amount)]);
    }
    if (vals.length) {
      blocks.push({ type: 'subheading', text: 'Valuations by method' }, {
        type: 'table', widths: [2, 1.5, 1.3, 1.5, 1.2], columns: ['Property', 'Method', 'Date', 'Provider', 'Value'],
        align: ['left', 'left', 'left', 'left', 'right'], rows: vals,
      });
    }
  }

  if (s.assets.length) {
    blocks.push({ type: 'heading', text: 'Other assets' }, {
      type: 'table', widths: [1.2, 2, 1.6, 1.2], columns: ['Type', 'Description', 'Held with', 'Value'], align: ['left', 'left', 'left', 'right'],
      rows: s.assets.map((a) => [titleCase(a.asset_type), a.description || '–', a.institution || '–', aud(a.value)]),
      total: ['Total', '', '', aud(t.other_assets)],
    });
  }

  for (const [key, title] of [['actions_to_consider', 'Actions to consider'], ['broker_to_action', 'What we\'ll do (broker to action)'], ['next_steps', 'Next steps']]) {
    if (review[key]) blocks.push({ type: 'heading', text: title }, { type: 'text', text: review[key] });
  }

  blocks.push({
    type: 'note',
    text: `This review summarises the information we hold as at ${d(review.review_date)} and is general information only. It is not a credit proposal, a recommendation or an offer of finance, and does not take into account changes in your circumstances. Lender rates, fees and policies change regularly – please speak with us before making any changes to your lending.${s.business.acl ? ` ${s.business.name} – ${s.business.acl}.` : ''}`,
  });

  return {
    title: review.title,
    prepared_for: names,
    date: d(review.review_date),
    broker: s.broker,
    business: s.business,
    blocks,
  };
}

// ---- Lending-structure diagram as SVG ----------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function structureSvg(structure) {
  const colour = branding.emailColours().link;
  const W = 520;
  const BOX = 190;
  const RIGHT = W - BOX;
  let y = 14; // room for the column labels
  const loanPos = new Map();
  const parts = [];
  for (const g of structure.lenders) {
    const secured = g.loans.filter((n) => !n.unsecured);
    if (!secured.length) continue;
    const logo = lenderLogos.logoData(g.logo_id);
    if (logo) {
      const { width, height } = fitBox(logo.width, logo.height, 70, 16);
      parts.push(`<image x="0" y="${y}" width="${width}" height="${height}" href="data:${logo.mime};base64,${logo.data.toString('base64')}"/>`);
      parts.push(`<text x="${width + 6}" y="${y + 11}" font-family="Helvetica" font-size="9" font-weight="bold" fill="#374151">${esc(clip(g.name, 24))}</text>`);
      y += Math.max(16, height + 4);
    } else {
      parts.push(`<text x="0" y="${y + 11}" font-family="Helvetica" font-size="9" font-weight="bold" fill="#374151">${esc(clip(g.name, 30))}</text>`);
      y += 16;
    }
    for (const n of secured) {
      parts.push(`<rect x="0.5" y="${y + 0.5}" width="${BOX}" height="34" rx="4" fill="#ffffff" stroke="${n.cross_collateralised ? '#b45309' : '#cbd5e1'}"/>`);
      parts.push(`<text x="8" y="${y + 14}" font-family="Helvetica" font-size="8.5" fill="#111827">${esc(clip(typeLabel(n.loan_type), 24))}</text>`);
      parts.push(`<text x="${BOX - 8}" y="${y + 14}" text-anchor="end" font-family="Helvetica" font-size="8.5" font-weight="bold" fill="#111827">${esc(aud(n.owing))}</text>`);
      const sub = [n.interest_rate ? `${n.interest_rate}%` : null, n.rate_type !== 'variable' && n.fixed_expiry_date ? `fixed to ${d(n.fixed_expiry_date)}` : n.rate_type, n.repayment_type === 'io' ? 'IO' : null].filter(Boolean).join(' · ');
      parts.push(`<text x="8" y="${y + 27}" font-family="Helvetica" font-size="7.5" fill="#6b7280">${esc(clip(sub, 40))}</text>`);
      loanPos.set(n.id, { y: y + 17, cross: n.cross_collateralised });
      y += 40;
    }
    y += 6;
  }
  const leftHeight = y;
  let py = 16;
  const propPos = new Map();
  const props = structure.properties.filter((p) => p.loan_ids.length);
  const gap = Math.max(46, (leftHeight - 16) / Math.max(1, props.length));
  for (const p of props) {
    parts.push(`<rect x="${RIGHT + 0.5}" y="${py + 0.5}" width="${BOX - 1}" height="40" rx="4" fill="#ffffff" stroke="${colour}"/>`);
    parts.push(`<text x="${RIGHT + 8}" y="${py + 14}" font-family="Helvetica" font-size="8.5" font-weight="bold" fill="#111827">${esc(clip(shortAddr(p.address), 26))}</text>`);
    parts.push(`<text x="${W - 8}" y="${py + 14}" text-anchor="end" font-family="Helvetica" font-size="8.5" fill="#111827">${esc(aud(p.current_value))}</text>`);
    parts.push(`<text x="${RIGHT + 8}" y="${py + 30}" font-family="Helvetica" font-size="7.5" fill="${p.lvr > 80 ? '#b91c1c' : '#6b7280'}">LVR ${esc(pct(p.lvr))} · owing ${esc(aud(p.secured_debt))}</text>`);
    propPos.set(p.id, py + 20);
    py += gap;
  }
  const height = Math.max(leftHeight, py) + 4;
  const lines = [];
  for (const g of structure.lenders) {
    for (const n of g.loans) {
      const from = loanPos.get(n.id);
      if (!from) continue;
      for (const pid of n.security_ids) {
        const toY = propPos.get(pid);
        if (toY === undefined) continue;
        const mid = (BOX + RIGHT) / 2;
        lines.push(`<path d="M${BOX} ${from.y} C${mid} ${from.y} ${mid} ${toY} ${RIGHT} ${toY}" fill="none" stroke="${from.cross ? '#b45309' : colour}" stroke-width="1.5"${from.cross ? ' stroke-dasharray="4 3"' : ''}/>`);
      }
    }
  }
  parts.unshift(`<text x="0" y="8" font-family="Helvetica" font-size="7" fill="#6b7280">LENDERS &amp; LOANS</text><text x="${RIGHT}" y="8" font-family="Helvetica" font-size="7" fill="#6b7280">SECURITY PROPERTIES</text>`);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">${lines.join('')}${parts.join('')}</svg>`, width: W, height };
}

// ---- Renderers -----------------------------------------------------------------------------

// Commentary text → paragraphs and bullet lists.
function textParts(text) {
  const out = [];
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^([•*\-–]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      const item = line.slice(bullet[0].length);
      const last = out[out.length - 1];
      if (last?.list) last.list.push(item);
      else out.push({ list: [item] });
    } else out.push({ para: line });
  }
  return out;
}

function logoData() {
  const b = branding.getBrand();
  if (!b.logo) return null;
  const asset = branding.getAsset(b.logo.id);
  if (!asset || !['image/png', 'image/jpeg'].includes(asset.mime)) return null;
  return { mime: asset.mime, data: Buffer.from(asset.data), width: asset.width, height: asset.height, url: b.logo.url };
}

function renderHtml(m) {
  const colour = branding.emailColours().link;
  const logo = logoData();
  const cell = (s) => esc(s).replace(/\n/g, '<br>');
  const body = m.blocks.map((b) => {
    if (b.type === 'heading') return `<h2>${esc(b.text)}</h2>`;
    if (b.type === 'subheading') return `<h3>${esc(b.text)}</h3>`;
    if (b.type === 'text') return textParts(b.text).map((p) => (p.list ? `<ul>${p.list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(p.para)}</p>`)).join('');
    if (b.type === 'tiles') return `<div class="tiles">${b.items.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`;
    if (b.type === 'diagram') return `<div class="diagram">${b.svg.svg}</div>`;
    if (b.type === 'note') return `<p class="note">${esc(b.text)}</p>`;
    if (b.type === 'table') {
      const al = (i) => (b.align?.[i] === 'right' ? ' class="r"' : '');
      const td = (c, i) => {
        const logo = cellLogo(c);
        const img = logo ? (() => { const f = fitBox(logo.width, logo.height, 90, 22); return `<img class="lender-logo" src="${logo.url}" width="${f.width}" height="${f.height}" alt=""><br>`; })() : '';
        return `<td${al(i)}>${img}${cell(cellText(c))}</td>`;
      };
      return `<table><thead><tr>${b.columns.map((c, i) => `<th${al(i)}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('')}${b.total ? `<tr class="total">${b.total.map(td).join('')}</tr>` : ''}</tbody></table>`;
    }
    return '';
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
body{font-family:Arial,Helvetica,sans-serif;color:#1f2933;margin:0;background:#f3f4f6}
.page{max-width:780px;margin:24px auto;background:#fff;padding:40px 48px;border-top:6px solid ${colour};box-shadow:0 1px 3px rgba(0,0,0,.08)}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:1px solid #e5e7eb;padding-bottom:16px}
header img{max-height:60px;max-width:220px}.biz{text-align:right;font-size:12px;color:#4b5563;line-height:1.5}
h1{font-size:24px;margin:24px 0 4px;color:#111827}.meta{color:#4b5563;font-size:13px;margin-bottom:20px}
h2{font-size:15px;color:${colour};text-transform:uppercase;letter-spacing:.04em;margin:28px 0 8px;border-bottom:2px solid ${colour};padding-bottom:4px}
h3{font-size:13px;margin:16px 0 6px;color:#374151}p,li{font-size:13.5px;line-height:1.55}ul{padding-left:20px;margin:6px 0}
.tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.tiles div{background:#f3f4f6;border-radius:6px;padding:10px}
.tiles span{display:block;font-size:11px;color:#6b7280}.tiles strong{font-size:16px}
table{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0}th{text-align:left;background:#f3f4f6;color:#374151;padding:6px;font-weight:600}
td{padding:6px;border-bottom:1px solid #e5e7eb;vertical-align:top}.r{text-align:right}tr.total td{font-weight:bold;border-top:2px solid #d1d5db}
.diagram{margin:8px 0 12px;overflow-x:auto}img.lender-logo{margin-bottom:3px}.note{font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:28px}
@media (max-width:700px){.page{padding:24px}.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="page">
<header><div>${logo ? `<img src="${logo.url}" alt="${esc(m.business.name)}">` : `<strong style="font-size:20px">${esc(m.business.name)}</strong>`}</div>
<div class="biz"><strong>${esc(m.business.name)}</strong><br>${[m.business.phone, m.business.email, m.business.website].filter(Boolean).map(esc).join('<br>')}</div></header>
<h1>${esc(m.title)}</h1>
<div class="meta">Prepared for <strong>${esc(m.prepared_for)}</strong> · ${esc(m.date)} · by ${esc(m.broker.name || '')}${m.broker.phone ? `, ${esc(m.broker.phone)}` : ''}</div>
${body}
</div></body></html>`;
}

const PDF_FONTS = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };

async function renderPdf(m) {
  const pdfmake = require('pdfmake');
  pdfmake.setFonts(PDF_FONTS);
  pdfmake.setUrlAccessPolicy(() => false); // never fetch remote resources
  pdfmake.setLocalAccessPolicy((p) => /^Helvetica(-Bold|-Oblique|-BoldOblique)?$/.test(p)); // built-in fonts only
  const colour = branding.emailColours().link;
  const logo = logoData();
  const content = [];

  content.push({
    columns: [
      logo ? { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [180, 55] } : { text: m.business.name, bold: true, fontSize: 16 },
      { stack: [{ text: m.business.name, bold: true }, ...[m.business.phone, m.business.email, m.business.website].filter(Boolean)], alignment: 'right', fontSize: 9, color: '#4b5563' },
    ],
  });
  content.push({ canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 0.5, lineColor: '#e5e7eb' }] });
  content.push({ text: m.title, fontSize: 20, bold: true, margin: [0, 16, 0, 2], color: '#111827' });
  content.push({ text: [{ text: 'Prepared for ' }, { text: m.prepared_for, bold: true }, ` · ${m.date} · by ${m.broker.name || ''}${m.broker.phone ? `, ${m.broker.phone}` : ''}`], color: '#4b5563', fontSize: 10, margin: [0, 0, 0, 10] });

  for (const b of m.blocks) {
    if (b.type === 'heading') {
      content.push({ text: b.text.toUpperCase(), color: colour, bold: true, fontSize: 11, margin: [0, 16, 0, 2] });
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1.2, lineColor: colour }], margin: [0, 0, 0, 6] });
    } else if (b.type === 'subheading') {
      content.push({ text: b.text, bold: true, fontSize: 10, margin: [0, 10, 0, 4], color: '#374151' });
    } else if (b.type === 'text') {
      for (const p of textParts(b.text)) content.push(p.list ? { ul: p.list, margin: [0, 2, 0, 4] } : { text: p.para, margin: [0, 2, 0, 4] });
    } else if (b.type === 'tiles') {
      content.push({
        table: { widths: b.items.map(() => '*'), body: [b.items.map(([k, v]) => ({ stack: [{ text: k, fontSize: 8, color: '#6b7280' }, { text: v, bold: true, fontSize: 12 }], fillColor: '#f3f4f6', margin: [4, 4, 4, 4] }))] },
        layout: { hLineWidth: () => 0, vLineWidth: () => 3, vLineColor: () => '#ffffff' },
        margin: [0, 4, 0, 4],
      });
    } else if (b.type === 'diagram') {
      content.push({ svg: b.svg.svg, width: Math.min(515, b.svg.width), margin: [0, 4, 0, 8] });
    } else if (b.type === 'table') {
      const total = b.widths.reduce((s, w) => s + w, 0);
      const al = (i) => b.align?.[i] || 'left';
      content.push({
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: b.widths.map((w) => `${(w / total) * 100}%`),
          body: [
            b.columns.map((c, i) => ({ text: c, bold: true, fillColor: '#f3f4f6', fontSize: 8.5, alignment: al(i) })),
            ...b.rows.map((r) => r.map((c, i) => {
              const logo = cellLogo(c);
              const text = { text: cellText(c), fontSize: 8.5, alignment: al(i) };
              return logo ? { stack: [{ image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [60, 16], margin: [0, 0, 0, 2] }, text] } : text;
            })),
            ...(b.total ? [b.total.map((c, i) => ({ text: cellText(c), bold: true, fontSize: 8.5, alignment: al(i) }))] : []),
          ],
        },
        layout: { hLineWidth: (i) => (i === 0 ? 0 : 0.5), vLineWidth: () => 0, hLineColor: () => '#e5e7eb', paddingTop: () => 4, paddingBottom: () => 4 },
        margin: [0, 2, 0, 6],
      });
    } else if (b.type === 'note') {
      content.push({ text: b.text, fontSize: 7.5, color: '#6b7280', margin: [0, 20, 0, 0] });
    }
  }

  const doc = pdfmake.createPdf({
    info: { title: m.title, author: m.business.name, subject: `Lending review for ${m.prepared_for}` },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Helvetica', fontSize: 10, lineHeight: 1.25, color: '#1f2933' },
    footer: (page, pages) => ({
      columns: [{ text: `${m.title} – ${m.prepared_for}`, fontSize: 7.5, color: '#9ca3af' }, { text: `Page ${page} of ${pages}`, alignment: 'right', fontSize: 7.5, color: '#9ca3af' }],
      margin: [40, 16, 40, 0],
    }),
    content,
  });
  return doc.getBuffer();
}

async function renderDocx(m) {
  const D = require('docx');
  const colour = branding.emailColours().link.replace('#', '');
  const logo = logoData();
  const children = [];
  const para = (text, opts = {}) => new D.Paragraph({ spacing: { after: 80 }, ...opts, children: [new D.TextRun({ text, font: 'Arial', size: 21, ...opts.run })] });

  const headerCells = [
    new D.TableCell({
      children: [logo
        ? new D.Paragraph({ children: [new D.ImageRun({ type: logo.mime === 'image/png' ? 'png' : 'jpg', data: logo.data, transformation: { width: Math.round(Math.min(180, (55 * logo.width) / logo.height)), height: Math.round(Math.min(55, (180 * logo.height) / logo.width)) } })] })
        : para(m.business.name, { run: { bold: true, size: 32 } })],
    }),
    new D.TableCell({
      children: [m.business.name, m.business.phone, m.business.email, m.business.website].filter(Boolean)
        .map((t, i) => new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [new D.TextRun({ text: t, font: 'Arial', size: 17, bold: i === 0, color: '4B5563' })] })),
    }),
  ];
  const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  children.push(new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    borders: { top: none, bottom: { style: D.BorderStyle.SINGLE, size: 4, color: 'E5E7EB' }, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: [new D.TableRow({ children: headerCells })],
  }));
  children.push(new D.Paragraph({ spacing: { before: 300, after: 60 }, children: [new D.TextRun({ text: m.title, bold: true, size: 40, font: 'Arial', color: '111827' })] }));
  children.push(new D.Paragraph({
    spacing: { after: 200 },
    children: [new D.TextRun({ text: 'Prepared for ', font: 'Arial', size: 20, color: '4B5563' }), new D.TextRun({ text: m.prepared_for, bold: true, font: 'Arial', size: 20 }),
      new D.TextRun({ text: ` · ${m.date} · by ${m.broker.name || ''}${m.broker.phone ? `, ${m.broker.phone}` : ''}`, font: 'Arial', size: 20, color: '4B5563' })],
  }));

  const cellPara = (text, { bold = false, align = 'left', size = 17 } = {}) => String(text).split('\n').map((line, i) => new D.Paragraph({
    alignment: align === 'right' ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT,
    children: [new D.TextRun({ text: line, bold, font: 'Arial', size: i ? size - 2 : size, color: i ? '6B7280' : '1F2933' })],
  }));
  const thin = { style: D.BorderStyle.SINGLE, size: 2, color: 'E5E7EB' };

  for (const b of m.blocks) {
    if (b.type === 'heading') {
      children.push(new D.Paragraph({
        keepNext: true,
        spacing: { before: 280, after: 100 },
        border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: colour, space: 2 } },
        children: [new D.TextRun({ text: b.text.toUpperCase(), bold: true, color: colour, font: 'Arial', size: 22 })],
      }));
    } else if (b.type === 'subheading') {
      children.push(para(b.text, { keepNext: true, spacing: { before: 160, after: 60 }, run: { bold: true, size: 20 } }));
    } else if (b.type === 'text') {
      for (const p of textParts(b.text)) {
        if (p.list) p.list.forEach((item) => children.push(new D.Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new D.TextRun({ text: item, font: 'Arial', size: 21 })] })));
        else children.push(para(p.para));
      }
    } else if (b.type === 'tiles') {
      children.push(new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: { style: D.BorderStyle.SINGLE, size: 24, color: 'FFFFFF' } },
        rows: [new D.TableRow({
          children: b.items.map(([k, v]) => new D.TableCell({
            shading: { fill: 'F3F4F6', type: D.ShadingType.CLEAR, color: 'auto' },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new D.Paragraph({ children: [new D.TextRun({ text: k, font: 'Arial', size: 15, color: '6B7280' })] }),
              new D.Paragraph({ children: [new D.TextRun({ text: v, font: 'Arial', size: 24, bold: true })] })],
          })),
        })],
      }));
    } else if (b.type === 'table') {
      const total = b.widths.reduce((s, w) => s + w, 0);
      const al = (i) => b.align?.[i] || 'left';
      const row = (cells, { header = false, bold = false } = {}) => new D.TableRow({
        tableHeader: header,
        cantSplit: true,
        children: cells.map((c, i) => new D.TableCell({
          width: { size: Math.round((b.widths[i] / total) * 100), type: D.WidthType.PERCENTAGE },
          shading: header ? { fill: 'F3F4F6', type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          children: [
            ...(() => {
              const logo = cellLogo(c);
              if (!logo) return [];
              const f = fitBox(logo.width, logo.height, 70, 18);
              return [new D.Paragraph({ children: [new D.ImageRun({ type: logo.mime === 'image/png' ? 'png' : 'jpg', data: logo.data, transformation: f })] })];
            })(),
            ...cellPara(cellText(c), { bold: header || bold, align: al(i) }),
          ],
        })),
      });
      children.push(new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        borders: { top: none, bottom: thin, left: none, right: none, insideHorizontal: thin, insideVertical: none },
        rows: [row(b.columns, { header: true }), ...b.rows.map((r) => row(r)), ...(b.total ? [row(b.total, { bold: true })] : [])],
      }));
      children.push(new D.Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (b.type === 'note') {
      children.push(new D.Paragraph({ spacing: { before: 300 }, children: [new D.TextRun({ text: b.text, font: 'Arial', size: 15, color: '6B7280' })] }));
    }
    // The diagram is shown as the property table in Word.
  }

  const doc = new D.Document({
    creator: m.business.name,
    title: m.title,
    description: `Lending review for ${m.prepared_for}`,
    sections: [{
      properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } },
      footers: {
        default: new D.Footer({
          children: [new D.Paragraph({
            alignment: D.AlignmentType.RIGHT,
            children: [new D.TextRun({ children: [`${m.title} – ${m.prepared_for}    Page `, D.PageNumber.CURRENT, ' of ', D.PageNumber.TOTAL_PAGES], font: 'Arial', size: 14, color: '9CA3AF' })],
          })],
        }),
      },
      children,
    }],
  });
  return D.Packer.toBuffer(doc);
}

function fileName(review, ext) {
  const s = JSON.parse(review.snapshot);
  const safe = `${review.title} - ${s.contact.full_name} - ${review.review_date}`.replace(/[^\w .,&()-]+/g, '').replace(/\s+/g, ' ').trim();
  return `${safe}.${ext}`;
}

module.exports = { snapshot, suggestions, model, renderHtml, renderPdf, renderDocx, structureSvg, textParts, fileName };
