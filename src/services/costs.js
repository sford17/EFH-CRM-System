'use strict';
// Running costs: Anthropic (Claude) usage and SMS (ClickSend).
//
// Every Claude request is recorded in `ai_usage` with its tokens, web searches
// and an estimated cost at Anthropic's published list prices (USD), priced by
// the model that actually answered. Your invoice can differ slightly (tax,
// credits, rounding). Texts record ClickSend's own price when it's returned;
// otherwise the cost is estimated from the message parts and your price per part.
const db = require('../db');
const { nowIso, today, HttpError } = require('../util');

// USD per million tokens (Anthropic list prices). Longest prefix wins, so
// "claude-opus-5-5" is matched before "claude-opus-5".
// [input, 5-minute cache write, 1-hour cache write, cache read, output]
const PRICES = [
  ['claude-fable-5-1', [10, 12.5, 20, 0.25, 50]],
  ['claude-mythos-5-1', [10, 12.5, 20, 0.25, 50]],
  ['claude-fable-5', [10, 12.5, 20, 1, 50]],
  ['claude-mythos-5', [10, 12.5, 20, 1, 50]],
  ['claude-opus-5-5', [4, 5, 8, 0.2, 20]],
  ['claude-opus-5', [5, 6.25, 10, 0.5, 25]],
  ['claude-opus-4-8', [5, 6.25, 10, 0.5, 25]],
  ['claude-opus-4-7', [5, 6.25, 10, 0.5, 25]],
  ['claude-opus-4-6', [5, 6.25, 10, 0.5, 25]],
  ['claude-opus-4-5', [5, 6.25, 10, 0.5, 25]],
  ['claude-opus-4-1', [15, 18.75, 30, 1.5, 75]],
  ['claude-opus-4', [15, 18.75, 30, 1.5, 75]],
  ['claude-sonnet-5-5', [2, 2.5, 4, 0.1, 10]],
  ['claude-sonnet-5', [2, 2.5, 4, 0.2, 10]],
  ['claude-sonnet-4', [3, 3.75, 6, 0.3, 15]],
  ['claude-haiku-5-5', [0.1, 0.125, 0.2, 0.01, 0.5]],
  ['claude-haiku-4-5', [1, 1.25, 2, 0.1, 5]],
];
const HAIKU_55_LONG = [0.5, 0.625, 1, 0.05, 2.5]; // prompts over 100,000 tokens
const WEB_SEARCH_USD = 10 / 1000;

const FEATURES = {
  assistant: 'AI assistant',
  newsletter: 'Client newsletter',
  partner_newsletter: 'Partner newsletter',
  lead_generator: 'Lead generator',
  property_report: 'Property reports',
  loan_documents: 'Settlement letters (document reading)',
  other: 'Other',
};

function priceFor(model, promptTokens = 0) {
  const id = String(model || '').toLowerCase();
  const hit = PRICES.filter(([p]) => id.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  if (!hit) return null;
  if (hit[0] === 'claude-haiku-5-5' && promptTokens > 100000) return HAIKU_55_LONG;
  return hit[1];
}

// Cost in USD of one response's usage (as returned by the API).
function costOf(model, u = {}) {
  const input = u.input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const write5m = Math.max(0, cacheWrite - write1h);
  const p = priceFor(model, input + cacheRead + cacheWrite) || priceFor(require('./loanDocsAI').DEFAULT_MODEL);
  const tokens = (input * p[0] + write5m * p[1] + write1h * p[2] + cacheRead * p[3] + (u.output_tokens || 0) * p[4]) / 1e6;
  return tokens + (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
}

// Called for every finished Claude response.
function record(feature, message, { userId = null } = {}) {
  const u = message?.usage;
  if (!u) return null;
  try {
    return db.insert('ai_usage', {
      feature: FEATURES[feature] ? feature : 'other', model: message.model || null, user_id: userId,
      input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
      cache_write_tokens: u.cache_creation_input_tokens || 0, cache_read_tokens: u.cache_read_input_tokens || 0,
      web_searches: u.server_tool_use?.web_search_requests || 0, web_fetches: u.server_tool_use?.web_fetch_requests || 0,
      cost_usd: Math.round(costOf(message.model, u) * 1e6) / 1e6,
    });
  } catch {
    return null; // recording costs must never break the feature itself
  }
}

// Past usage saved before this ledger existed (totals only, so estimated).
function backfill(database = db) {
  const add = (feature, model, at, usage, userId = null) => {
    if (!usage) return;
    let u;
    try { u = JSON.parse(usage); } catch { return; }
    if (!u || !(u.input_tokens || u.output_tokens)) return;
    const full = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, server_tool_use: { web_search_requests: u.web_searches || 0 } };
    const m = model || database.getSetting('ai_model', '') || 'claude-opus-5-5';
    database.insert('ai_usage', {
      feature, model: m, user_id: userId, created_at: at, estimated: 1,
      input_tokens: full.input_tokens, output_tokens: full.output_tokens, cache_read_tokens: full.cache_read_input_tokens, web_searches: full.server_tool_use.web_search_requests,
      cost_usd: Math.round(costOf(m, full) * 1e6) / 1e6,
    });
  };
  for (const r of database.all('SELECT model, usage, COALESCE(generated_at, updated_at) AS at FROM newsletters WHERE usage IS NOT NULL')) add('newsletter', r.model, r.at, r.usage);
  for (const r of database.all('SELECT model, usage, COALESCE(generated_at, updated_at) AS at FROM partner_newsletters WHERE usage IS NOT NULL')) add('partner_newsletter', r.model, r.at, r.usage);
  for (const r of database.all('SELECT model, usage, updated_at AS at FROM property_reports WHERE usage IS NOT NULL')) add('property_report', r.model, r.at, r.usage);
  for (const r of database.all('SELECT model, usage, created_at AS at, user_id FROM lead_searches WHERE usage IS NOT NULL')) add('lead_generator', r.model, r.at, r.usage, r.user_id);
  for (const r of database.all('SELECT usage, updated_at AS at, user_id FROM ai_conversations WHERE usage IS NOT NULL')) add('assistant', null, r.at, r.usage, r.user_id);
}

// ---- Settings -------------------------------------------------------------------------------------

function settings() {
  const rate = Number(db.getSetting('usd_to_aud', ''));
  const part = Number(db.getSetting('sms_price_per_part', ''));
  return { usd_to_aud: rate > 0 ? rate : null, sms_price_per_part: part > 0 ? part : null };
}
function saveSettings({ usd_to_aud: rate, sms_price_per_part: part } = {}) {
  const check = (v, label, max) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return '';
    const n = Number(v);
    if (!(n > 0 && n < max)) throw new HttpError(400, `Enter a ${label}`);
    return String(n);
  };
  const r = check(rate, 'US dollar to Australian dollar rate, e.g. 1.52', 10);
  const p = check(part, 'price per SMS part in dollars, e.g. 0.07', 5);
  if (r !== undefined) db.setSetting('usd_to_aud', r);
  if (p !== undefined) db.setSetting('sms_price_per_part', p);
  return settings();
}

// ---- The report -------------------------------------------------------------------------------------

const segments = (text) => require('./sms').segments(String(text || ''));
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const monthsBetween = (from, to) => {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
};

// Texts actually sent (logged ones never left the CRM, so they cost nothing).
function smsRows(from, to) {
  const s = settings();
  return db.all("SELECT id, body, parts, price, currency, COALESCE(sent_at, created_at) AS at, sender_user_id FROM sms_messages WHERE status = 'sent' AND substr(COALESCE(sent_at, created_at), 1, 10) BETWEEN ? AND ?", from, to)
    .map((m) => {
      const parts = m.parts || segments(m.body);
      const known = m.price !== null && m.price !== undefined;
      return { ...m, parts, cost: known ? m.price : s.sms_price_per_part ? parts * s.sms_price_per_part : null, estimated: !known };
    });
}

function report({ from, to }) {
  const s = settings();
  const months = monthsBetween(from, to);
  const ai = db.all('SELECT substr(created_at, 1, 7) AS month, feature, COUNT(*) AS requests, SUM(input_tokens + cache_write_tokens + cache_read_tokens) AS tokens_in, SUM(output_tokens) AS tokens_out, SUM(web_searches) AS searches, SUM(cost_usd) AS usd, MAX(estimated) AS estimated FROM ai_usage WHERE substr(created_at, 1, 10) BETWEEN ? AND ? GROUP BY month, feature', from, to);
  const sms = smsRows(from, to);
  const toAud = (usd) => (s.usd_to_aud ? usd * s.usd_to_aud : null);
  let running = 0;
  let runningUsd = 0;
  const rows = months.map((month) => {
    const a = ai.filter((x) => x.month === month);
    const t = sms.filter((x) => x.at.slice(0, 7) === month);
    const usd = a.reduce((x, y) => x + (y.usd || 0), 0);
    const smsCost = t.reduce((x, y) => x + (y.cost || 0), 0);
    const smsUnpriced = t.filter((x) => x.cost === null).length;
    const aud = toAud(usd);
    const total = aud === null ? null : aud + smsCost;
    runningUsd += usd;
    if (total !== null) running += total;
    return {
      month, ai_requests: a.reduce((x, y) => x + y.requests, 0), ai_usd: r2(usd), ai_aud: aud === null ? null : r2(aud), ai_estimated: a.some((x) => x.estimated),
      sms_count: t.length, sms_parts: t.reduce((x, y) => x + y.parts, 0), sms_aud: r2(smsCost), sms_estimated: t.some((x) => x.estimated), sms_unpriced: smsUnpriced,
      total_aud: total === null ? null : r2(total), running_aud: total === null ? null : r2(running), running_usd: r2(runningUsd),
      raw_usd: usd, raw_sms: smsCost,
    };
  });
  const byFeature = Object.entries(FEATURES).map(([key, labelText]) => {
    const a = ai.filter((x) => x.feature === key);
    const usd = a.reduce((x, y) => x + (y.usd || 0), 0);
    return {
      key, label: labelText, requests: a.reduce((x, y) => x + y.requests, 0), tokens_in: a.reduce((x, y) => x + (y.tokens_in || 0), 0), tokens_out: a.reduce((x, y) => x + (y.tokens_out || 0), 0),
      searches: a.reduce((x, y) => x + (y.searches || 0), 0), usd: r2(usd), aud: s.usd_to_aud ? r2(usd * s.usd_to_aud) : null,
    };
  }).filter((f) => f.requests).sort((a, b) => b.usd - a.usd);
  const smsBySender = [...new Set(sms.map((m) => m.sender_user_id))].map((id) => {
    const t = sms.filter((m) => m.sender_user_id === id);
    return { name: id ? db.one('SELECT name FROM users WHERE id = ?', id)?.name || 'Former user' : 'Automations / business number', count: t.length, parts: t.reduce((x, y) => x + y.parts, 0), aud: r2(t.reduce((x, y) => x + (y.cost || 0), 0)) };
  }).sort((a, b) => b.aud - a.aud || b.count - a.count);

  // All-time and this month, whatever period is shown.
  const allAi = db.one('SELECT COALESCE(SUM(cost_usd), 0) AS usd, MIN(created_at) AS since FROM ai_usage');
  const allSms = smsRows('2000-01-01', '2999-12-31');
  const month = today().slice(0, 7);
  const thisAi = db.one('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM ai_usage WHERE substr(created_at, 1, 7) = ?', month).usd;
  const thisSms = allSms.filter((m) => m.at.slice(0, 7) === month);
  // Unrounded amounts, so converted totals match the table to the cent.
  const raw = {
    period: [rows.reduce((x, y) => x + y.raw_usd, 0), rows.reduce((x, y) => x + y.raw_sms, 0), rows.reduce((x, y) => x + y.sms_count, 0)],
    month: [thisAi, thisSms.reduce((x, y) => x + (y.cost || 0), 0), thisSms.length],
    all: [allAi.usd, allSms.reduce((x, y) => x + (y.cost || 0), 0), allSms.length],
  };
  const totals = { since: allAi.since || allSms.map((m) => m.at).sort()[0] || null };
  for (const [k, [aiUsd, smsAud, count]] of Object.entries(raw)) {
    Object.assign(totals, {
      [`${k}_ai_usd`]: r2(aiUsd), [`${k}_sms_aud`]: r2(smsAud), [`${k}_sms_count`]: count,
      [`${k}_ai_aud`]: s.usd_to_aud ? r2(aiUsd * s.usd_to_aud) : null,
      [`${k}_total_aud`]: s.usd_to_aud ? r2(aiUsd * s.usd_to_aud + smsAud) : null,
    });
  }
  for (const r of rows) { delete r.raw_usd; delete r.raw_sms; }
  const unpriced = sms.filter((m) => m.cost === null).length;
  return {
    settings: s, months: rows, by_feature: byFeature, sms_by_sender: smsBySender, totals,
    notes: { sms_unpriced: unpriced, ai_estimated: ai.some((x) => x.estimated), sms_estimated: sms.some((m) => m.estimated && m.cost !== null) },
  };
}

module.exports = { PRICES, FEATURES, WEB_SEARCH_USD, priceFor, costOf, record, backfill, settings, saveSettings, report, monthsBetween, nowIso };
