'use strict';
// Property report: how a client's properties have performed (their valuation
// history from the mortgage tracker, growth, equity and LVR) alongside
// AI-researched data on each property's area (median prices, growth, rents,
// yields, local news), with sources. Sent as a branded email with a PDF.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const ai = require('./loanDocsAI');
const tracker = require('./tracker');
const branding = require('./branding');
const { today, nowIso, formatDate, HttpError } = require('../util');

const STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const money = (n) => (n === null || n === undefined ? '–' : `$${Math.round(n).toLocaleString('en-AU')}`);
const compact = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}m` : `$${Math.round(n / 1e3)}k`);
const pct = (n, dp = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(dp)}%`);
const monthYear = (d) => new Date(`${d}T00:00:00Z`).toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortAddress = (a) => String(a || '').split(',')[0];

// Suburb, state and postcode: from the property's fields, or its address.
function locationOf(p) {
  const m = /,\s*([A-Za-z][A-Za-z' .-]*?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b\s*(\d{4})?\s*$/i.exec(p.address || '');
  const suburb = p.suburb || m?.[1] || null;
  const state = (p.state || m?.[2] || '').toUpperCase() || null;
  const postcode = p.postcode || m?.[3] || null;
  return { suburb: suburb ? suburb.replace(/\b\w/g, (c) => c.toUpperCase()).trim() : null, state: STATES.includes(state) ? state : null, postcode };
}
const kindOf = (t) => (t === 'unit' ? 'unit' : 'house');
const areaKey = (loc, kind) => `${(loc.suburb || '').toLowerCase()}|${loc.state || ''}|${kind}`;

// ---- How the client's property has performed ---------------------------------------------------

function performance(propertyId, contactId) {
  const s = tracker.summary(contactId);
  const p = s.properties.find((x) => x.id === propertyId);
  if (!p) return null;
  const sp = s.structure.properties.find((x) => x.id === propertyId) || {};
  const history = [...p.valuations].sort((a, b) => a.valuation_date.localeCompare(b.valuation_date) || a.id - b.id);
  const points = history.map((v) => ({ date: v.valuation_date, amount: v.amount, method: v.method_label }));
  if (p.purchase_price && p.purchase_date && !points.some((x) => x.date === p.purchase_date)) {
    points.unshift({ date: p.purchase_date, amount: p.purchase_price, method: 'Purchase price' });
    points.sort((a, b) => a.date.localeCompare(b.date));
  }
  const start = p.purchase_price && p.purchase_date ? { date: p.purchase_date, amount: p.purchase_price, label: 'purchase' } : points[0] ? { ...points[0], label: 'first valuation' } : null;
  const current = p.current_value;
  const years = start && p.current_valuation ? (Date.parse(`${p.current_valuation.valuation_date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / (365.25 * 86400000) : null;
  const growth = start && current ? current - start.amount : null;
  const growthPct = start && current ? (growth / start.amount) * 100 : null;
  const perYear = start && current && years >= 1 ? (((current / start.amount) ** (1 / years)) - 1) * 100 : null;
  return {
    id: p.id, address: p.address, ...locationOf(p), property_type: p.property_type, usage: p.usage, status: p.status,
    purchase_price: p.purchase_price, purchase_date: p.purchase_date,
    current_value: current, current_valuation: p.current_valuation ? { date: p.current_valuation.valuation_date, method: p.current_valuation.method_label, amount: p.current_valuation.amount } : null,
    start, growth, growth_pct: growthPct, growth_per_year: perYear, years,
    owing: sp.secured_debt ?? null, equity: sp.equity ?? null, lvr: sp.lvr ?? null, usable_equity: sp.usable_equity ?? null,
    points,
  };
}

function performanceNote(perf) {
  if (!perf?.current_value) return 'We don\'t have a current valuation for this property yet.';
  const parts = [];
  if (perf.start && perf.start.label === 'purchase') parts.push(`You bought this property for ${money(perf.start.amount)} in ${monthYear(perf.start.date)}`);
  else if (perf.start) parts.push(`It was valued at ${money(perf.start.amount)} in ${monthYear(perf.start.date)}`);
  if (perf.current_valuation) parts.push(`${parts.length ? 'and it' : 'It'} is now valued at ${money(perf.current_value)} (${perf.current_valuation.method.toLowerCase()}, ${monthYear(perf.current_valuation.date)})`);
  let text = `${parts.join(' ')}.`;
  if (perf.growth !== null && perf.start) {
    text += ` That's ${perf.growth >= 0 ? 'up' : 'down'} ${money(Math.abs(perf.growth))}, or ${pct(Math.abs(perf.growth_pct))}${perf.growth_per_year !== null ? ` (about ${pct(perf.growth_per_year)} a year)` : ''}.`;
  }
  if (perf.owing) text += ` With about ${money(perf.owing)} owing, you have around ${money(Math.max(0, perf.equity))} in equity and an LVR of ${pct(perf.lvr)}.`;
  else if (perf.owing === 0) text += ' It\'s owned outright.';
  return text;
}

// ---- The area (AI web research) ---------------------------------------------------------------

const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const SOURCE = { type: 'object', additionalProperties: false, required: ['title', 'publisher', 'url'], properties: { title: { type: 'string' }, publisher: { type: 'string' }, url: { type: 'string' } } };
const AREA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['areas', 'notes_for_broker'],
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['suburb', 'state', 'property_type', 'summary', 'stats', 'trend', 'highlights', 'sources'],
        properties: {
          suburb: { type: 'string' },
          state: { type: 'string', enum: STATES },
          property_type: { type: 'string', enum: ['house', 'unit'] },
          summary: { type: 'string', description: 'Two short paragraphs for a home owner: how the local market is going and what\'s driving it' },
          stats: {
            type: 'array', description: 'Headline figures for this suburb and property type, e.g. median price, 12-month change, 5-year change, median weekly rent, gross rental yield, days on market, vacancy rate, number of sales',
            items: {
              type: 'object', additionalProperties: false, required: ['label', 'value', 'period', 'source_name', 'source_url'],
              properties: { label: { type: 'string' }, value: { type: 'string', description: 'As shown, e.g. "$1.42m", "+6.1%", "28 days"' }, period: nullable({ type: 'string' }, 'e.g. "12 months to Sep 2026"'), source_name: { type: 'string' }, source_url: { type: 'string' } },
            },
          },
          trend: nullable({
            type: 'object', additionalProperties: false, required: ['title', 'unit', 'items'],
            properties: { title: { type: 'string' }, unit: { type: 'string', enum: ['$', '%'] }, items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'number' } } } } },
          }, 'Median price by year (or similar) if a source gives it, oldest first; otherwise null'),
          highlights: { type: 'array', items: { type: 'string' }, description: 'Up to 5 recent local developments: infrastructure, transport, rezoning, schools, major projects' },
          sources: { type: 'array', items: SOURCE },
        },
      },
    },
    notes_for_broker: { type: 'array', items: { type: 'string' } },
  },
};

function systemPrompt() {
  return `You research Australian suburbs for a mortgage broker's client property reports. For each suburb you're given, search the web for current property market data and local news, then call save_area_data once with everything.

For each suburb and property type (house or unit), find:
- Headline figures: median price, 12-month change, longer-term growth (e.g. 5 or 10 years), median weekly rent, gross rental yield, days on market, vacancy rate and number of sales, whichever are available. Give each figure its period and the page it came from.
- A price trend over several years if a source shows one (for the trend chart), otherwise null.
- Recent local developments that affect property: transport and infrastructure, rezoning and major projects, new schools or amenities.
- A short, plain-English summary for a home owner.

Rules:
- Use reputable sources: Cotality (CoreLogic), PropTrack, Domain, realestate.com.au suburb profiles, SQM Research, the ABS, state and local government sites, and major news outlets.
- Only report figures you found; never estimate. Different sources measure differently, so name the source for each figure. If you can't find something, leave it out.
- General information only: no forecasts presented as fact, and no advice about buying or selling.
- Write in your own words, in Australian English. Note anything uncertain in notes_for_broker.
Today is ${formatDate(today())}.`;
}

async function research(areas) {
  const client = ai.clientFor();
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 8 + areas.length * 4, user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' } },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 + areas.length * 4 },
    { name: 'save_area_data', description: 'Save the area data for every suburb. Call once at the end.', strict: true, eager_input_streaming: true, input_schema: AREA_SCHEMA },
  ];
  const messages = [{ role: 'user', content: `Research these areas:\n${areas.map((a) => `- ${a.suburb} ${a.state}${a.postcode ? ` ${a.postcode}` : ''} (${a.kind}s)`).join('\n')}` }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let model = ai.model();
  for (let turn = 0; turn < 8; turn += 1) {
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: ai.model(), max_tokens: 32000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, system: systemPrompt(), tools, tool_choice: { type: 'auto' }, messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      messages.push({ role: 'user', content: 'The data didn\'t come through complete. Please call save_area_data again.' });
      continue;
    }
    model = message.model || model;
    usage.input_tokens += message.usage?.input_tokens || 0;
    usage.output_tokens += message.usage?.output_tokens || 0;
    usage.web_searches += message.usage?.server_tool_use?.web_search_requests || 0;
    if (message.stop_reason === 'refusal') throw new HttpError(502, 'The AI service declined this research.');
    if (message.stop_reason === 'max_tokens') throw new HttpError(502, 'The research came out too long. Try fewer properties.');
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue;
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === 'save_area_data');
    if (!call) {
      messages.push({ role: 'user', content: 'Please call save_area_data now with what you found.' });
      continue;
    }
    if (!Array.isArray(call.input?.areas)) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: 'areas must be a list' }) }] });
      continue;
    }
    return { ...call.input, model, usage };
  }
  throw new HttpError(502, 'The area research didn\'t finish. Try again.');
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const httpsUrl = (u) => {
  try { const url = new URL(String(u)); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
};
function cleanArea(a = {}, key = null) {
  const items = Array.isArray(a.trend?.items) ? a.trend.items.map((i) => ({ label: text(i?.label, 30), value: Number(i?.value) })).filter((i) => i.label && Number.isFinite(i.value)).slice(0, 15) : [];
  return {
    key: key || areaKey({ suburb: a.suburb, state: a.state }, a.property_type === 'unit' ? 'unit' : 'house'),
    suburb: text(a.suburb, 80), state: STATES.includes(a.state) ? a.state : null, property_type: a.property_type === 'unit' ? 'unit' : 'house',
    summary: text(a.summary, 4000),
    stats: (Array.isArray(a.stats) ? a.stats : []).map((s) => ({ label: text(s?.label, 60), value: text(s?.value, 40), period: text(s?.period, 60) || null, source_name: text(s?.source_name, 80), source_url: httpsUrl(s?.source_url) }))
      .filter((s) => s.label && s.value).slice(0, 12),
    trend: items.length >= 2 ? { title: text(a.trend.title, 120), unit: a.trend.unit === '%' ? '%' : '$', items } : null,
    highlights: (Array.isArray(a.highlights) ? a.highlights : []).map((h) => text(h, 400)).filter(Boolean).slice(0, 6),
    sources: (Array.isArray(a.sources) ? a.sources : []).map((s) => ({ title: text(s?.title, 200), publisher: text(s?.publisher, 80), url: httpsUrl(s?.url) })).filter((s) => s.url).slice(0, 10),
  };
}

// ---- Reports ----------------------------------------------------------------------------------------

const running = new Set();

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service is busy. Try again in a few minutes.';
  if (err instanceof Anthropic.APIError) return `The AI service had a problem (${err.status ?? 'no response'}). Try again shortly.`;
  return err.message || String(err);
}

function load(id) {
  const r = db.one('SELECT * FROM property_reports WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Report not found');
  return { ...r, property_ids: JSON.parse(r.property_ids), content: r.content ? JSON.parse(r.content) : null };
}

function ownedProperties(contactId) {
  const ids = require('./household').householdIds(contactId);
  const marks = ids.map(() => '?').join(',');
  return db.all(`SELECT * FROM properties WHERE (contact_id IN (${marks}) OR co_owner_id IN (${marks})) AND status != 'sold' ORDER BY id`, ...ids, ...ids);
}

// The properties a report can cover, with whether their area can be researched.
const candidates = (contactId) => ownedProperties(contactId).map((p) => {
  const loc = locationOf(p);
  const perf = performance(p.id, contactId);
  return { id: p.id, address: p.address, ...loc, property_type: p.property_type, ready: Boolean(loc.suburb && loc.state), valuations: perf ? perf.points.length : 0, current_value: perf?.current_value ?? null };
});

// Starts a report for the chosen properties; the area research runs in the background.
function create(contactId, propertyIds, userId) {
  if (!ai.configured()) throw new HttpError(400, 'Property reports need an Anthropic API key. An admin can add one in Settings → AI.');
  const contact = db.one('SELECT id, first_name, last_name FROM contacts WHERE id = ?', contactId);
  if (!contact) throw new HttpError(404, 'Contact not found');
  const owned = ownedProperties(contactId);
  const chosen = (Array.isArray(propertyIds) && propertyIds.length ? owned.filter((p) => propertyIds.map(Number).includes(p.id)) : owned).slice(0, 6);
  if (!chosen.length) throw new HttpError(400, 'Choose at least one property');
  const areas = [];
  for (const p of chosen) {
    const loc = locationOf(p);
    if (!loc.suburb || !loc.state) throw new HttpError(400, `Add the suburb and state for ${shortAddress(p.address)} first (edit the property)`);
    const key = areaKey(loc, kindOf(p.property_type));
    if (!areas.some((a) => a.key === key)) areas.push({ ...loc, kind: kindOf(p.property_type), key });
  }
  const firstName = contact.first_name;
  const content = {
    title: chosen.length > 1 ? 'Your property report' : `Property report: ${shortAddress(chosen[0].address)}`,
    intro: `Hi ${firstName},\n\nHere's an update on how your propert${chosen.length > 1 ? 'ies have' : 'y has'} performed, based on the valuations we've collected over time, along with the latest market data and news for your area.`,
    properties: chosen.map((p) => ({ property_id: p.id, area_key: areaKey(locationOf(p), kindOf(p.property_type)), note: performanceNote(performance(p.id, contactId)) })),
    areas: [],
    notes_for_broker: [],
    closing: 'If you\'re thinking about what your equity could do for you – renovating, investing, or simply getting a sharper rate – we\'d love to talk it through.',
  };
  const id = db.insert('property_reports', { contact_id: contactId, property_ids: JSON.stringify(chosen.map((p) => p.id)), content: JSON.stringify(content), created_by: userId });
  const done = runResearch(id, areas);
  return { id, done };
}

function runResearch(id, areas) {
  running.add(id);
  return (async () => {
    try {
      const r = await research(areas);
      const report = load(id);
      const found = (r.areas || []).map((a) => cleanArea(a));
      // Match what came back to the areas asked for (by suburb and type).
      report.content.areas = areas.map((want) => {
        const hit = found.find((f) => f.key === want.key) || found.find((f) => (f.suburb || '').toLowerCase() === want.suburb.toLowerCase());
        return hit ? { ...hit, key: want.key, suburb: want.suburb, state: want.state, property_type: want.kind } : { key: want.key, suburb: want.suburb, state: want.state, property_type: want.kind, summary: '', stats: [], trend: null, highlights: [], sources: [] };
      });
      report.content.notes_for_broker = (r.notes_for_broker || []).map((n) => text(n, 400)).filter(Boolean).slice(0, 10);
      db.update('property_reports', id, { status: 'ready', content: JSON.stringify(report.content), model: r.model, usage: JSON.stringify(r.usage), error: null, updated_at: nowIso() });
      if (report.created_by) db.insert('notifications', { user_id: report.created_by, message: `Property report ready to review for ${contactName(report.contact_id)}`, link: `#/property-reports/${id}` });
    } catch (err) {
      const report = db.one('SELECT content FROM property_reports WHERE id = ?', id);
      const hadAreas = report?.content && JSON.parse(report.content).areas.length;
      db.update('property_reports', id, { status: hadAreas ? 'ready' : 'failed', error: friendly(err), updated_at: nowIso() });
    } finally {
      running.delete(id);
    }
  })();
}

// Researches the areas again (keeps the broker's wording for the rest).
function refreshAreas(id) {
  const r = load(id);
  if (r.status === 'researching' || running.has(id)) throw new HttpError(400, 'The research is already running');
  if (!ai.configured()) throw new HttpError(400, 'AI isn\'t set up');
  const props = db.all(`SELECT * FROM properties WHERE id IN (${r.property_ids.map(() => '?').join(',')})`, ...r.property_ids);
  const areas = [];
  for (const p of props) {
    const loc = locationOf(p);
    const key = areaKey(loc, kindOf(p.property_type));
    if (loc.suburb && loc.state && !areas.some((a) => a.key === key)) areas.push({ ...loc, kind: kindOf(p.property_type), key });
  }
  db.update('property_reports', id, { status: 'researching', error: null, updated_at: nowIso() });
  return { id, done: runResearch(id, areas) };
}

const contactName = (id) => {
  const c = db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', id);
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ');
};

function cleanContent(c, existing) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'Nothing to save');
  return {
    title: text(c.title, 150) || existing.title,
    intro: text(c.intro, 4000),
    closing: text(c.closing, 2000),
    properties: existing.properties.map((p) => {
      const edit = (Array.isArray(c.properties) ? c.properties : []).find((x) => Number(x?.property_id) === p.property_id);
      return { ...p, note: edit ? text(edit.note, 3000) : p.note };
    }),
    areas: existing.areas.map((a) => {
      const edit = (Array.isArray(c.areas) ? c.areas : []).find((x) => x?.key === a.key);
      return edit ? { ...cleanArea({ ...edit, suburb: a.suburb, state: a.state, property_type: a.property_type }, a.key) } : a;
    }),
    notes_for_broker: existing.notes_for_broker,
  };
}

function save(id, content) {
  const r = load(id);
  if (r.status === 'researching') throw new HttpError(400, 'Wait for the research to finish');
  db.update('property_reports', id, { content: JSON.stringify(cleanContent(content, r.content)), updated_at: nowIso(), ...(r.status === 'failed' ? { status: 'ready' } : {}) });
  return get(id);
}

function get(id) {
  const r = load(id);
  const perfs = r.property_ids.map((pid) => performance(pid, r.contact_id)).filter(Boolean);
  return {
    id: r.id, contact_id: r.contact_id, contact_name: contactName(r.contact_id), status: r.status, error: r.error, usage: r.usage ? JSON.parse(r.usage) : null,
    created_at: r.created_at, updated_at: r.updated_at, sent_at: r.sent_at, sent_to: r.sent_to, content: r.content,
    performance: perfs, to: db.one('SELECT email FROM contacts WHERE id = ?', r.contact_id)?.email || null,
  };
}

const listFor = (contactId) => db.all('SELECT id, status, property_ids, created_at, sent_at, sent_to FROM property_reports WHERE contact_id = ? ORDER BY id DESC LIMIT 20', contactId)
  .map((r) => ({ ...r, property_count: JSON.parse(r.property_ids).length, property_ids: undefined }));

const remove = (id) => db.run('DELETE FROM property_reports WHERE id = ?', id).changes > 0;

// ---- Charts -------------------------------------------------------------------------------------------

// Column chart (SVG) of a property's valuations, for the document and PDF.
function valuationSvg(points, colour) {
  if (points.length < 2) return null;
  const W = 515;
  const H = 210;
  const pad = { l: 8, r: 8, t: 22, b: 34 };
  const max = Math.max(...points.map((p) => p.amount));
  const min = Math.min(...points.map((p) => p.amount));
  const floor = Math.max(0, min - (max - min) * 0.6 - max * 0.05);
  const n = points.length;
  const slot = (W - pad.l - pad.r) / n;
  const bw = Math.min(56, slot * 0.62);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - floor) / (max - floor || 1));
  const bars = points.map((p, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    const top = y(p.amount);
    const fill = i === n - 1 ? colour : '#9aa5b1';
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - pad.b - top).toFixed(1)}" rx="3" fill="${fill}"/>
<text x="${(x + bw / 2).toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle" font-family="Helvetica" font-size="9" font-weight="bold" fill="#1f2933">${esc(compact(p.amount))}</text>
<text x="${(x + bw / 2).toFixed(1)}" y="${H - pad.b + 13}" text-anchor="middle" font-family="Helvetica" font-size="8.5" fill="#4b5563">${esc(monthYear(p.date))}</text>
<text x="${(x + bw / 2).toFixed(1)}" y="${H - pad.b + 25}" text-anchor="middle" font-family="Helvetica" font-size="7.5" fill="#6b7280">${esc(p.method.replace(' valuation', '').slice(0, 16))}</text>`;
  }).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" stroke="#d1d5db" stroke-width="1"/>
${bars}
</svg>`;
  return { svg, width: W, height: H };
}

// ---- Rendering: document (HTML preview + PDF) and email ---------------------------------------------------

function business() {
  return {
    name: db.getSetting('business_name', ''), phone: db.getSetting('business_phone', ''), email: db.getSetting('business_email', ''),
    website: db.getSetting('business_website', ''), acl: db.getSetting('acl_number', ''),
  };
}

const typeWord = (t) => (t === 'unit' ? 'units' : 'houses');

function model(report) {
  const colour = branding.emailColours().primary;
  const c = report.content;
  const blocks = [];
  if (c.intro) blocks.push({ type: 'text', text: c.intro });
  for (const pp of c.properties) {
    const perf = report.performance.find((x) => x.id === pp.property_id);
    if (!perf) continue;
    blocks.push({ type: 'heading', text: perf.address });
    blocks.push({ type: 'tiles', items: [
      ['Current value', perf.current_value ? money(perf.current_value) : '–'],
      [perf.start?.label === 'purchase' ? 'Growth since purchase' : 'Growth', perf.growth_pct !== null ? `${perf.growth >= 0 ? '+' : ''}${pct(perf.growth_pct)}` : '–'],
      ['Growth per year', perf.growth_per_year !== null ? pct(perf.growth_per_year) : '–'],
      ['Equity', perf.equity !== null && perf.owing ? money(Math.max(0, perf.equity)) : perf.owing === 0 ? 'Owned outright' : '–'],
      ['LVR', perf.lvr !== null && perf.owing ? pct(perf.lvr) : '–'],
    ] });
    if (pp.note) blocks.push({ type: 'text', text: pp.note });
    const chart = valuationSvg(perf.points, colour);
    if (chart) blocks.push({ type: 'subheading', text: 'Valuation history' }, { type: 'diagram', svg: chart });
    if (perf.points.length) {
      blocks.push({
        type: 'table', widths: [1, 1.4, 1], columns: ['Date', 'Valuation', 'Value'], align: ['left', 'left', 'right'],
        rows: perf.points.map((p) => [formatDate(p.date), p.method, money(p.amount)]),
      });
    }
    const area = c.areas.find((a) => a.key === pp.area_key);
    if (area && (area.summary || area.stats.length)) {
      blocks.push({ type: 'subheading', text: `About ${area.suburb} (${typeWord(area.property_type)})` });
      if (area.summary) blocks.push({ type: 'text', text: area.summary });
      if (area.stats.length) {
        blocks.push({
          type: 'table', widths: [1.3, 0.9, 1.2, 1], columns: ['Measure', 'Figure', 'Period', 'Source'], align: ['left', 'right', 'left', 'left'],
          rows: area.stats.map((s) => [s.label, s.value, s.period || '–', s.source_name || '–']),
        });
      }
      if (area.trend) {
        const t = area.trend;
        blocks.push({
          type: 'table', widths: [1, 1], columns: [t.title || 'Trend', ''], align: ['left', 'right'],
          rows: t.items.map((i) => [i.label, t.unit === '$' ? money(i.value) : pct(i.value)]),
        });
      }
      if (area.highlights.length) blocks.push({ type: 'text', text: `What's happening locally:\n${area.highlights.map((h) => `• ${h}`).join('\n')}` });
    }
  }
  if (c.closing) blocks.push({ type: 'heading', text: 'Let\'s talk' }, { type: 'text', text: c.closing });
  const sources = [...new Map(c.areas.flatMap((a) => [...a.sources, ...a.stats.filter((s) => s.source_url).map((s) => ({ title: s.source_name, publisher: s.source_name, url: s.source_url }))]).map((s) => [s.url, s])).values()];
  blocks.push({
    type: 'note',
    text: `Valuations are estimates from the sources shown (desktop, AVM, contract price and other methods differ) and aren't formal valuations. Area data is from third-party sources as at the dates shown${sources.length ? `: ${sources.map((s) => s.publisher || s.title).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')}` : ''}. This report is general information only and doesn't take into account your objectives, financial situation or needs.${business().acl ? ` ${business().name} – ${business().acl}.` : ''}`,
  });
  const contact = db.one('SELECT first_name, last_name FROM contacts WHERE id = ?', report.contact_id);
  const owner = db.one('SELECT u.name, u.email, u.phone FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?', report.contact_id) || {};
  return { title: c.title, prepared_for: [contact.first_name, contact.last_name].filter(Boolean).join(' '), date: formatDate(today()), broker: owner, business: business(), blocks };
}

function emailHtml(report, senderId) {
  const { emailParts: E } = require('./newsletter');
  const col = branding.emailColours();
  const c = report.content;
  const html = [];
  const txt = [];
  html.push(`<h1 style="margin:0 0 14px 0;font-family:${E.FONT};font-size:24px;line-height:1.25;color:${col.dark};">${E.esc(c.title)}</h1>`, E.para(c.intro, col));
  txt.push(c.title, c.intro);
  for (const pp of c.properties) {
    const perf = report.performance.find((x) => x.id === pp.property_id);
    if (!perf) continue;
    html.push(E.heading(perf.address, col));
    txt.push(perf.address.toUpperCase());
    html.push(E.keyNumbers([
      { label: 'Current value', value: perf.current_value ? compact(perf.current_value) : '–', note: perf.current_valuation ? monthYear(perf.current_valuation.date) : '' },
      { label: 'Growth', value: perf.growth_pct !== null ? `${perf.growth >= 0 ? '+' : ''}${pct(perf.growth_pct)}` : '–', note: perf.start ? `since ${monthYear(perf.start.date)}` : '' },
      { label: 'Equity', value: perf.owing ? compact(Math.max(0, perf.equity)) : perf.owing === 0 ? 'All yours' : '–', note: perf.owing ? `LVR ${pct(perf.lvr)}` : '' },
    ].filter((k) => k.value !== '–'), col));
    if (pp.note) { html.push(E.para(pp.note, col)); txt.push(pp.note); }
    if (perf.points.length >= 2) {
      html.push(E.barChart({ title: 'Valuation history', unit: '$', items: perf.points.map((p) => ({ label: `${monthYear(p.date)} · ${p.method.replace(' valuation', '')}`, value: p.amount })) }, col));
      txt.push(perf.points.map((p) => `${monthYear(p.date)} (${p.method}): ${money(p.amount)}`).join('\n'));
    }
    const area = c.areas.find((a) => a.key === pp.area_key);
    if (area && (area.summary || area.stats.length)) {
      html.push(`<h3 style="margin:18px 0 8px 0;font-family:${E.FONT};font-size:16px;color:${col.dark};">About ${E.esc(area.suburb)} (${typeWord(area.property_type)})</h3>`);
      txt.push(`ABOUT ${area.suburb.toUpperCase()}`);
      if (area.summary) { html.push(E.para(area.summary, col)); txt.push(area.summary); }
      if (area.stats.length) {
        html.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;border:1px solid ${E.BORDER};border-radius:8px;border-collapse:separate;">${area.stats.map((s, i) => `<tr>
<td style="padding:8px 12px;font-family:${E.FONT};font-size:13px;color:${E.MUTED};${i ? `border-top:1px solid ${E.BORDER};` : ''}">${E.esc(s.label)}${s.period ? `<div style="font-size:11px;">${E.esc(s.period)}</div>` : ''}</td>
<td align="right" style="padding:8px 12px;font-family:${E.FONT};font-size:15px;font-weight:bold;color:${col.dark};${i ? `border-top:1px solid ${E.BORDER};` : ''}">${E.esc(s.value)}</td></tr>`).join('')}</table>`);
        txt.push(area.stats.map((s) => `${s.label}: ${s.value}${s.period ? ` (${s.period})` : ''}`).join('\n'));
      }
      if (area.trend) {
        html.push(E.barChart({ title: area.trend.title || 'Trend', unit: area.trend.unit, items: area.trend.items }, col));
      }
      if (area.highlights.length) {
        html.push(`<p style="margin:0 0 6px 0;font-weight:bold;">What's happening locally</p>`, E.para(area.highlights.map((h) => `- ${h}`).join('\n'), col));
        txt.push(`What's happening locally:\n${area.highlights.map((h) => `- ${h}`).join('\n')}`);
      }
      const srcs = [...new Map([...area.sources, ...area.stats.filter((s) => s.source_url).map((s) => ({ title: s.source_name, publisher: s.source_name, url: s.source_url }))].map((s) => [s.url, s])).values()].slice(0, 6);
      html.push(E.sourceLine(srcs, col));
    }
  }
  const contact = db.one('SELECT id, first_name, last_name, email, owner_id FROM contacts WHERE id = ?', report.contact_id);
  const bookUrl = require('./templating').bookingLinkFor(contact.owner_id || senderId, contact) || db.getSetting('newsletter_booking_url', '');
  if (c.closing) { html.push(E.heading('Let\'s talk', col), E.para(c.closing, col)); txt.push(c.closing); }
  if (bookUrl) { html.push(E.button('Book a time to chat', bookUrl, col)); txt.push(`Book a time: ${bookUrl}`); }
  html.push(`<p style="margin:16px 0 0 0;font-size:11px;line-height:1.5;color:${E.MUTED};">Valuations are estimates and aren't formal valuations. Area data comes from the third-party sources shown. This is general information only and doesn't take into account your objectives, financial situation or needs. The full report is attached as a PDF.</p>`);
  return { html: html.join('\n'), text: txt.filter(Boolean).join('\n\n') };
}

const fileName = (report) => `${report.content.title.replace(/[\\/:*?"<>|]/g, '')}.pdf`;

async function send(id, { to, subject }, userId) {
  const report = get(id);
  if (report.status === 'researching') throw new HttpError(400, 'Wait for the research to finish');
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to).trim())) throw new HttpError(400, 'Enter the client\'s email address');
  const contact = db.one('SELECT owner_id FROM contacts WHERE id = ?', report.contact_id);
  const senderId = contact.owner_id || userId;
  const pdf = await require('./review').renderPdf(model(report));
  const body = emailHtml(report, senderId);
  const mailer = require('./mailer');
  const outboxId = mailer.queueEmail({
    to: String(to).trim(), subject: String(subject || report.content.title).slice(0, 200), body: body.text, htmlBody: body.html,
    contactId: report.contact_id, senderUserId: senderId, attachments: [{ filename: fileName(report), mime: 'application/pdf', data: pdf }],
  });
  await mailer.processOutbox();
  const out = db.one('SELECT id, status, error FROM outbox WHERE id = ?', outboxId);
  if (out.status === 'failed') throw new HttpError(502, `The email couldn't be sent: ${out.error}`);
  db.update('property_reports', id, { status: 'sent', sent_at: nowIso(), sent_to: String(to).trim(), updated_at: nowIso() });
  db.insert('activities', { contact_id: report.contact_id, user_id: userId, type: 'system', body: `Property report emailed to ${String(to).trim()}` });
  return { outbox: out, report: get(id) };
}

module.exports = { candidates, create, refreshAreas, get, save, listFor, remove, model, emailHtml, send, fileName, performance, performanceNote, locationOf, valuationSvg, cleanArea, AREA_SCHEMA, running };
