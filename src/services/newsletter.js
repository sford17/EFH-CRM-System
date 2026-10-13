'use strict';
// Monthly client newsletter. On the chosen day each month, Claude researches
// the month's banking, finance and property news on the web (AFR, RBA,
// Cotality/CoreLogic and other reputable sources) and writes the newsletter.
// The broker gets an email to review it, then sends it to clients. Each
// client's copy includes their own interest rates compared with the market
// average, plus a link to book a meeting.
const crypto = require('node:crypto');
const net = require('node:net');
const db = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const ai = require('./loanDocsAI');
const branding = require('./branding');
const { today, nowIso, formatDate, HttpError } = require('../util');

const FONT = 'Arial, Helvetica, sans-serif';
const MUTED = '#5f6b7a';
const TEXT = '#1f2933';
const BORDER = '#e3e7ec';

const DEFAULT_SOURCES = [
  'afr.com', 'rba.gov.au', 'abs.gov.au', 'apra.gov.au', 'treasury.gov.au', 'cotality.com.au', 'corelogic.com.au', 'proptrack.com.au',
  'domain.com.au', 'realestate.com.au', 'canstar.com.au', 'ratecity.com.au', 'finder.com.au', 'abc.net.au', 'smh.com.au', 'theage.com.au', 'mfaa.com.au',
];
const RATE_KEYS = ['owner_occupier_variable', 'investor_variable', 'owner_occupier_fixed', 'investor_fixed'];
const RATE_LABELS = {
  owner_occupier_variable: 'Owner-occupier variable', investor_variable: 'Investor variable',
  owner_occupier_fixed: 'Owner-occupier fixed', investor_fixed: 'Investor fixed',
};
const HOME_LOAN_TYPES = ['home_loan', 'investment_loan', 'line_of_credit', 'construction', 'bridging'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
const pct = (n) => `${Number(n).toFixed(2)}%`;
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const currentMonth = () => today().slice(0, 7);

// ---- Settings ---------------------------------------------------------------------------

const DEFAULTS = {
  newsletter_enabled: '1', newsletter_day: '20', newsletter_sources: DEFAULT_SOURCES.join('\n'), newsletter_booking_url: '',
  newsletter_audience: 'client', newsletter_reviewers: '',
};
const SETTING_KEYS = Object.keys(DEFAULTS);
const setting = (k) => db.getSetting(k, DEFAULTS[k]) ?? DEFAULTS[k];

function settings() {
  return {
    enabled: setting('newsletter_enabled') !== '0',
    day: Math.min(28, Math.max(1, Number(setting('newsletter_day')) || 20)),
    sources: sourceDomains(),
    booking_url: setting('newsletter_booking_url') || '',
    audience: setting('newsletter_audience').split(',').filter((s) => ['client', 'past_client', 'prospect'].includes(s)),
    reviewers: reviewers().map((u) => u.id),
    booking_ready: bookingReady(),
  };
}

// Is there anything for the "Book a meeting" button to link to?
function bookingReady() {
  return Boolean(setting('newsletter_booking_url') || db.getSetting('business_website', '')
    || db.one("SELECT 1 FROM calendly_accounts WHERE connected = 1 AND COALESCE(scheduling_url, '') != ''"));
}

function saveSettings(body = {}) {
  if (body.enabled !== undefined) db.setSetting('newsletter_enabled', body.enabled ? '1' : '0');
  if (body.day !== undefined) {
    const d = Number(body.day);
    if (!Number.isInteger(d) || d < 1 || d > 28) throw new HttpError(400, 'Choose a day from 1 to 28');
    db.setSetting('newsletter_day', String(d));
  }
  if (body.sources !== undefined) {
    const list = String(Array.isArray(body.sources) ? body.sources.join('\n') : body.sources).split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')).filter(Boolean);
    const bad = list.find((s) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s));
    if (bad) throw new HttpError(400, `"${bad}" isn't a website address (e.g. afr.com)`);
    if (list.length > 40) throw new HttpError(400, 'List up to 40 websites');
    db.setSetting('newsletter_sources', [...new Set(list)].join('\n'));
  }
  if (body.booking_url !== undefined) {
    const u = String(body.booking_url || '').trim();
    if (u && !/^https:\/\/\S+$/i.test(u)) throw new HttpError(400, 'The booking link should start with https://');
    db.setSetting('newsletter_booking_url', u);
  }
  if (body.audience !== undefined) {
    const a = (Array.isArray(body.audience) ? body.audience : String(body.audience).split(',')).filter((s) => ['client', 'past_client', 'prospect'].includes(s));
    if (!a.length) throw new HttpError(400, 'Choose who receives the newsletter');
    db.setSetting('newsletter_audience', a.join(','));
  }
  if (body.reviewers !== undefined) {
    const ids = (Array.isArray(body.reviewers) ? body.reviewers : []).map(Number).filter((id) => db.one('SELECT 1 FROM users WHERE id = ? AND active = 1', id));
    db.setSetting('newsletter_reviewers', ids.join(','));
  }
  return settings();
}

const sourceDomains = () => setting('newsletter_sources').split(/\s+/).filter(Boolean);

// Who's emailed when the newsletter is ready: chosen users, else the admins.
function reviewers() {
  const ids = setting('newsletter_reviewers').split(',').map(Number).filter(Boolean);
  const chosen = ids.length ? db.all(`SELECT id, name, email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  return chosen.length ? chosen : db.all("SELECT id, name, email FROM users WHERE active = 1 AND role = 'admin' ORDER BY id");
}

// ---- Writing it (Claude + web search) ----------------------------------------------------

const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const SOURCE = {
  type: 'object', additionalProperties: false, required: ['title', 'publisher', 'url'],
  properties: { title: { type: 'string' }, publisher: { type: 'string' }, url: { type: 'string', description: 'The page you used (https)' } },
};
const NEWSLETTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'preheader', 'headline', 'intro', 'key_numbers', 'sections', 'market_rates', 'notes_for_broker'],
  properties: {
    subject: { type: 'string', description: 'Email subject line, under 70 characters' },
    preheader: { type: 'string', description: 'One-line inbox preview, under 110 characters' },
    headline: { type: 'string', description: 'Main headline for the month' },
    intro: { type: 'string', description: 'Two or three short paragraphs, separated by a blank line' },
    key_numbers: {
      type: 'array', description: '3 or 4 headline figures, e.g. the cash rate, national home value change, average variable rate',
      items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'note'], properties: { label: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } } },
    },
    sections: {
      type: 'array', description: '3 to 5 sections, e.g. interest rates & the RBA, the property market, banking & lending news, a tip for borrowers',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'body', 'chart', 'sources'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Short paragraphs separated by blank lines; lines starting "- " are bullet points' },
          chart: nullable({
            type: 'object', additionalProperties: false, required: ['title', 'unit', 'items'],
            properties: {
              title: { type: 'string' },
              unit: { type: 'string', enum: ['%', '$', 'number'] },
              items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'number' } } } },
            },
          }, 'An optional bar chart of figures from your sources (e.g. home value change by capital city). Use null when there\'s nothing worth charting.'),
          sources: { type: 'array', items: SOURCE },
        },
      },
    },
    market_rates: {
      type: 'object', additionalProperties: false, required: [...RATE_KEYS, 'as_at', 'source_name', 'source_url'],
      description: 'Average Australian home loan interest rates for new or outstanding loans (e.g. from the RBA lending rates statistics or a comparison site), as annual percentages',
      properties: {
        owner_occupier_variable: nullable({ type: 'number' }), investor_variable: nullable({ type: 'number' }),
        owner_occupier_fixed: nullable({ type: 'number' }), investor_fixed: nullable({ type: 'number' }),
        as_at: nullable({ type: 'string' }, 'Month or date the averages are for'), source_name: nullable({ type: 'string' }), source_url: nullable({ type: 'string' }),
      },
    },
    notes_for_broker: { type: 'array', items: { type: 'string' }, description: 'Anything the broker should double-check before sending' },
  },
};

function systemPrompt(month, business) {
  return `You write the monthly client newsletter for ${business || 'an Australian mortgage broking business'}, a mortgage broker in Australia. Readers are the broker's clients: home owners and property investors.

Research this month's news with web search, preferring the Australian Financial Review (afr.com) and official or data sources such as the RBA, ABS, APRA and Cotality (CoreLogic). Then call the save_newsletter tool once with the finished newsletter.

What to cover, for ${monthLabel(month)}:
- Interest rates: the latest RBA cash rate decision and what's expected next, and lender rate moves.
- The property market: home values and rents nationally and by capital city.
- Banking and lending: news that matters to borrowers (lender policy, regulation, government schemes).
- One practical tip for borrowers.
- The current average home loan interest rates (market_rates), for the client rate comparison.

Rules:
- General information only. Don't give personal advice or recommend specific lenders or products. Present forecasts as forecasts, with who made them.
- Every figure must come from a source you found this month; list the pages you used in each section's sources. Don't invent numbers. If a figure isn't available, leave it out (or null in market_rates).
- Write in your own words: summarise, don't copy articles. No quotes longer than a short phrase.
- Plain, warm Australian English for everyday readers. Short paragraphs. No jargon without a quick explanation.
- Add anything uncertain or that needs checking to notes_for_broker.`;
}

const SAVE_TOOL = {
  name: 'save_newsletter',
  description: 'Save the finished newsletter. Call this once, after your research, with the complete newsletter.',
  strict: true,
  eager_input_streaming: true,
  input_schema: NEWSLETTER_SCHEMA,
};

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const httpsUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
const rateNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 25 ? Math.round(v * 100) / 100 : null);
const sources = (list) => (Array.isArray(list) ? list : []).map((s) => ({ title: text(s?.title, 200), publisher: text(s?.publisher, 80), url: httpsUrl(s?.url) }))
  .filter((s) => s.url && s.title).slice(0, 8);

// Checks the newsletter (from the AI, or edited by the broker) and keeps only
// what's well-formed. Throws if the essentials are missing.
function clean(c = {}) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'The newsletter content is missing');
  const out = {
    subject: text(c.subject, 150),
    preheader: text(c.preheader, 200),
    headline: text(c.headline, 200),
    intro: text(c.intro, 4000),
    key_numbers: (Array.isArray(c.key_numbers) ? c.key_numbers : []).map((k) => ({ label: text(k?.label, 60), value: text(k?.value, 30), note: text(k?.note, 120) }))
      .filter((k) => k.label && k.value).slice(0, 4),
    sections: (Array.isArray(c.sections) ? c.sections : []).map((s) => {
      const items = Array.isArray(s?.chart?.items) ? s.chart.items.map((i) => ({ label: text(i?.label, 40), value: Number(i?.value) })).filter((i) => i.label && Number.isFinite(i.value)).slice(0, 12) : [];
      return {
        title: text(s?.title, 150),
        body: text(s?.body, 6000),
        chart: items.length >= 2 ? { title: text(s.chart.title, 150), unit: ['%', '$', 'number'].includes(s.chart.unit) ? s.chart.unit : 'number', items } : null,
        sources: sources(s?.sources),
      };
    }).filter((s) => s.title && s.body).slice(0, 8),
    market_rates: Object.fromEntries([
      ...RATE_KEYS.map((k) => [k, rateNum(c.market_rates?.[k])]),
      ['as_at', text(c.market_rates?.as_at, 60) || null], ['source_name', text(c.market_rates?.source_name, 120) || null], ['source_url', httpsUrl(c.market_rates?.source_url)],
    ]),
    notes_for_broker: (Array.isArray(c.notes_for_broker) ? c.notes_for_broker : []).map((n) => text(n, 400)).filter(Boolean).slice(0, 20),
  };
  const missing = ['subject', 'headline', 'intro'].filter((k) => !out[k]);
  if (missing.length) throw new HttpError(400, `The newsletter needs a ${missing.join(', ')}`);
  if (!out.sections.length) throw new HttpError(400, 'The newsletter needs at least one section');
  return out;
}

async function write(month) {
  const client = ai.clientFor();
  const business = db.getSetting('business_name', '');
  const domains = sourceDomains();
  const webConfig = domains.length ? { allowed_domains: domains } : {};
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 15, user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' }, ...webConfig },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10, ...webConfig },
    SAVE_TOOL,
  ];
  const messages = [{ role: 'user', content: `Please research and write the ${monthLabel(month)} client newsletter. Today is ${formatDate(today())}.` }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let model = ai.model();
  for (let turn = 0; turn < 8; turn += 1) {
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: ai.model(),
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: systemPrompt(month, business),
        tools,
        tool_choice: { type: 'auto' },
        messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      // The SDK couldn't parse the newsletter as it streamed: ask again.
      messages.push({ role: 'user', content: 'The newsletter didn\'t come through complete. Please call save_newsletter again with the full newsletter.' });
      continue;
    }
    model = message.model || model;
    usage.input_tokens += message.usage?.input_tokens || 0;
    usage.output_tokens += message.usage?.output_tokens || 0;
    usage.web_searches += message.usage?.server_tool_use?.web_search_requests || 0;
    if (message.stop_reason === 'refusal') throw new HttpError(502, 'The AI service declined to write the newsletter this time. Try again, or write it by hand.');
    if (message.stop_reason === 'max_tokens') throw new HttpError(502, 'The newsletter came out too long. Try again.');
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue; // the web research is still going: let it carry on
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === 'save_newsletter');
    if (!call) {
      messages.push({ role: 'user', content: 'Please call save_newsletter now with the finished newsletter.' });
      continue;
    }
    try {
      return { content: clean(call.input), model, usage };
    } catch (err) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID: err.message }) }] });
    }
  }
  throw new HttpError(502, 'The AI service didn\'t finish the newsletter. Try again.');
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service was busy. Try again in a few minutes.';
  if (err instanceof Anthropic.APIError) return `The AI service had a problem (${err.status ?? 'no response'}): ${err.message}`;
  return err.message || String(err);
}

const running = new Set();

// Writes the newsletter for `month` (in the background) and tells the reviewers.
function generate(month = currentMonth(), { userId = null, regenerate = false } = {}) {
  if (!ai.configured()) throw new HttpError(400, 'AI isn\'t set up yet. An admin needs to add an Anthropic API key in Settings → AI.');
  const existing = db.one('SELECT * FROM newsletters WHERE month = ?', month);
  if (existing?.status === 'generating' || running.has(month)) throw new HttpError(400, 'This newsletter is already being written');
  if (existing?.status === 'sent') throw new HttpError(400, 'This month\'s newsletter has already been sent');
  if (existing && !regenerate && existing.status === 'ready') throw new HttpError(400, 'This month\'s newsletter is already written');
  const id = existing
    ? (db.update('newsletters', existing.id, { status: 'generating', error: null, updated_at: nowIso() }), existing.id)
    : db.insert('newsletters', { month, status: 'generating' });
  running.add(month);
  const done = (async () => {
    try {
      const r = await write(month);
      db.update('newsletters', id, {
        status: 'ready', content: JSON.stringify(r.content), model: r.model, usage: JSON.stringify(r.usage), generated_at: nowIso(), error: null, edited_by: null, updated_at: nowIso(),
      });
      notifyReady(id);
    } catch (err) {
      const message = friendly(err);
      // A failed regenerate keeps the earlier version.
      db.update('newsletters', id, { status: existing?.content ? 'ready' : 'failed', error: message, updated_at: nowIso() });
      for (const u of reviewers()) db.insert('notifications', { user_id: u.id, message: `The ${monthLabel(month)} newsletter couldn't be written: ${message}`, link: `#/newsletters/${id}` });
    } finally {
      running.delete(month);
    }
  })();
  return { id, done, userId };
}

function notifyReady(id) {
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', id);
  const c = JSON.parse(n.content);
  const link = require('./reminders').crmUrl(`#/newsletters/${id}`);
  const count = recipients().length;
  for (const u of reviewers()) {
    db.insert('notifications', { user_id: u.id, message: `Your ${monthLabel(n.month)} newsletter is ready to review`, link: `#/newsletters/${id}` });
    if (!u.email) continue;
    require('./mailer').queueEmail({
      to: u.email,
      subject: `Your ${monthLabel(n.month)} newsletter is ready to review`,
      body: [
        `Hi ${u.name.split(' ')[0]},`,
        `Your ${monthLabel(n.month)} client newsletter has been written and is ready for you to check.`,
        `## ${c.headline}`,
        ...c.sections.map((s) => `- ${s.title}`),
        c.notes_for_broker.length ? `Please double-check:\n${c.notes_for_broker.map((x) => `- ${x}`).join('\n')}` : null,
        `Once you're happy with it, send it to your ${count} client${count === 1 ? '' : 's'} from the Newsletter page. Nothing goes to clients until you do.`,
        `[[button: Review the newsletter | ${link}]]`,
      ].filter(Boolean).join('\n\n'),
      senderUserId: u.id,
      internal: true,
    });
  }
  require('./mailer').processOutbox().catch(() => {});
}

// Scheduler: on or after the chosen day, write this month's newsletter once.
let warnedMonth = null;
function tick(now = today()) {
  const s = settings();
  if (!s.enabled) return null;
  const month = now.slice(0, 7);
  if (Number(now.slice(8, 10)) < s.day) return null;
  if (db.one('SELECT 1 FROM newsletters WHERE month = ?', month)) return null;
  if (!ai.configured()) {
    if (warnedMonth !== month && !db.one("SELECT 1 FROM notifications WHERE link = '#/newsletters' AND message LIKE ?", `%${monthLabel(month)}%`)) {
      for (const u of reviewers()) db.insert('notifications', { user_id: u.id, message: `The ${monthLabel(month)} newsletter wasn't written because AI isn't set up. Add an Anthropic API key in Settings.`, link: '#/newsletters' });
      warnedMonth = month;
    }
    return null;
  }
  return generate(month);
}

// ---- Who it goes to, and their rates ----------------------------------------------------------

function recipients() {
  const audience = settings().audience;
  const rows = db.all(
    `SELECT id, first_name, last_name, email, owner_id, status FROM contacts
     WHERE email IS NOT NULL AND trim(email) != '' AND marketing_opt_in = 1 AND status IN (${audience.map(() => '?').join(',')})
     ORDER BY first_name, last_name, id`,
    ...audience,
  );
  const seen = new Set();
  return rows.filter((r) => {
    const key = r.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The client's (household's) active home loans compared with the averages.
function rateCheck(contactId, rates) {
  if (!contactId) return [];
  const ids = require('./household').householdIds(contactId);
  const loans = db.all(
    `SELECT n.*, COALESCE(l.name, n.lender_name) AS lender, l.logo_asset_id FROM loans n LEFT JOIN lenders l ON l.id = n.lender_id
     WHERE (n.contact_id IN (${ids.map(() => '?').join(',')}) OR n.co_borrower_id IN (${ids.map(() => '?').join(',')}))
       AND n.status = 'active' AND n.interest_rate > 0 AND n.loan_type IN (${HOME_LOAN_TYPES.map(() => '?').join(',')})
     ORDER BY COALESCE(n.balance, n.limit_amount) DESC LIMIT 6`,
    ...ids, ...ids, ...HOME_LOAN_TYPES,
  );
  return loans.map((n) => {
    const investor = n.loan_type === 'investment_loan';
    const fixed = n.rate_type === 'fixed';
    const exactKey = `${investor ? 'investor' : 'owner_occupier'}_${fixed ? 'fixed' : 'variable'}`;
    const key = rates[exactKey] ? exactKey : rates[`${investor ? 'investor' : 'owner_occupier'}_variable`] ? `${investor ? 'investor' : 'owner_occupier'}_variable` : null;
    const average = key ? rates[key] : null;
    const balance = n.balance ?? n.limit_amount ?? 0;
    const diff = average === null ? null : Math.round((n.interest_rate - average) * 100) / 100;
    return {
      lender: n.lender || 'Your lender', logo_asset_id: n.logo_asset_id, loan_type: n.loan_type, rate_type: n.rate_type, rate: n.interest_rate,
      fixed_expiry_date: n.fixed_expiry_date, balance, average, average_label: key ? RATE_LABELS[key] : null,
      diff, yearly: diff === null || !balance ? null : Math.round((balance * diff) / 100),
    };
  });
}

// ---- The email -------------------------------------------------------------------------------------

const para = (t, c) => String(t).split(/\n{2,}/).map((p) => {
  const lines = p.split('\n');
  if (lines.every((l) => /^\s*[-•]\s+/.test(l))) {
    return `<ul style="margin:0 0 14px 0;padding-left:20px;">${lines.map((l) => `<li style="margin:0 0 6px 0;">${esc(l.replace(/^\s*[-•]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  return `<p style="margin:0 0 14px 0;">${esc(p).replace(/\n/g, '<br>')}</p>`;
}).join('');

const heading = (t, c) => `<h2 style="margin:26px 0 10px 0;font-family:${FONT};font-size:19px;line-height:1.3;color:${c.dark};border-bottom:2px solid ${c.primary};padding-bottom:6px;">${esc(t)}</h2>`;

function keyNumbers(items, c) {
  if (!items.length) return '';
  const cells = items.map((k) => `<td width="${Math.floor(100 / items.length)}%" valign="top" style="padding:4px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${c.soft}" style="background:${c.soft};border-radius:8px;padding:12px 10px;font-family:${FONT};text-align:center;">
<div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.5px;">${esc(k.label)}</div>
<div style="font-size:22px;font-weight:bold;color:${c.dark};margin:4px 0 2px 0;">${esc(k.value)}</div>
${k.note ? `<div style="font-size:11px;color:${MUTED};">${esc(k.note)}</div>` : ''}</td></tr></table></td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px 0;"><tr>${cells}</tr></table>`;
}

const fmtValue = (v, unit) => (unit === '%' ? `${Number(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%` : unit === '$' ? money(v) : Number(v).toLocaleString('en-AU'));

// Horizontal bar chart (tables only, so it shows in every email program).
function barChart(chart, c) {
  const max = Math.max(...chart.items.map((i) => Math.abs(i.value)), 0.0001);
  // An optional floor (e.g. for prices) makes differences between bars visible.
  const floor = chart.floor > 0 && chart.floor < max ? chart.floor : 0;
  const rows = chart.items.map((i) => {
    // Up to 78% wide, leaving room for the figure beside the longest bar.
    const w = Math.max(floor ? 8 : 2, Math.round(((Math.abs(i.value) - floor) / (max - floor)) * 78));
    const colour = i.value < 0 ? '#c0392b' : c.primary;
    return `<tr><td width="30%" style="padding:4px 8px 4px 0;font-family:${FONT};font-size:13px;color:${TEXT};white-space:nowrap;">${esc(i.label)}</td>
<td style="padding:4px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="${w}%" bgcolor="${colour}" style="background:${colour};height:14px;line-height:14px;font-size:1px;border-radius:3px;">&nbsp;</td>
<td width="${100 - w}%" style="padding-left:6px;font-family:${FONT};font-size:12px;font-weight:bold;color:${i.value < 0 ? '#c0392b' : c.dark};white-space:nowrap;">${esc(fmtValue(i.value, chart.unit))}</td></tr></table></td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;border:1px solid ${BORDER};border-radius:8px;border-collapse:separate;"><tr><td style="padding:14px 16px;">
<div style="font-family:${FONT};font-size:12px;font-weight:bold;letter-spacing:.5px;text-transform:uppercase;color:${c.link};margin:0 0 8px 0;">${esc(chart.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`;
}

const sourceLine = (list, c) => (list.length ? `<p style="margin:-4px 0 14px 0;font-size:12px;color:${MUTED};">Source${list.length > 1 ? 's' : ''}: ${list.map((s) => `<a href="${esc(s.url)}" style="color:${c.link};">${esc(s.publisher || s.title)}</a>`).join(', ')}</p>` : '');

// Two bars: the client's rate and the market average.
function rateCard(r, c) {
  const top = Math.max(r.rate, r.average || 0) * 1.08;
  const barRow = (labelText, value, colour) => `<tr><td width="34%" style="padding:3px 8px 3px 0;font-family:${FONT};font-size:12px;color:${MUTED};">${esc(labelText)}</td>
<td style="padding:3px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="${Math.round((value / top) * 100)}%" bgcolor="${colour}" style="background:${colour};height:16px;line-height:16px;font-size:1px;border-radius:3px;">&nbsp;</td>
<td style="padding-left:6px;font-family:${FONT};font-size:13px;font-weight:bold;color:${TEXT};white-space:nowrap;">${pct(value)}</td></tr></table></td></tr>`;
  const verdict = r.diff === null ? ''
    : r.diff > 0.05 ? `<div style="margin-top:8px;font-size:13px;color:#a8460c;"><strong>${r.diff.toFixed(2)}% above</strong> the average${r.yearly ? `, about <strong>${money(r.yearly)} a year</strong> in extra interest on ${money(r.balance)}` : ''}. Worth a review.</div>`
      : r.diff < -0.05 ? `<div style="margin-top:8px;font-size:13px;color:#1e7a46;"><strong>${(-r.diff).toFixed(2)}% below</strong> the average. Nicely done.</div>`
        : '<div style="margin-top:8px;font-size:13px;color:#1f2933;">Right in line with the average.</div>';
  const fixedNote = r.rate_type === 'fixed' && r.fixed_expiry_date ? `<div style="font-size:12px;color:${MUTED};margin-top:4px;">Fixed until ${esc(formatDate(r.fixed_expiry_date))}</div>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;border:1px solid ${BORDER};border-radius:8px;border-collapse:separate;"><tr><td style="padding:12px 14px;font-family:${FONT};">
<div style="font-size:14px;font-weight:bold;color:${TEXT};">${esc(r.lender)} · ${esc(r.loan_type === 'investment_loan' ? 'Investment loan' : 'Home loan')} (${esc(r.rate_type === 'fixed' ? 'fixed' : 'variable')})</div>${fixedNote}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">${barRow('Your rate', r.rate, c.primary)}${r.average ? barRow(r.average_label ? `Average (${r.average_label.toLowerCase()})` : 'Average', r.average, '#9aa5b1') : ''}</table>
${verdict}</td></tr></table>`;
}

function button(label, url, c) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px 0;"><tr>
<td bgcolor="${c.button}" style="background:${c.button};border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:bold;color:${c.onButton};text-decoration:none;border-radius:6px;">${esc(label)}</a></td></tr></table>`;
}

// ---- Unsubscribe -----------------------------------------------------------------------------------

function secretKey() {
  let k = db.getSetting('unsubscribe_secret', '');
  if (!k) {
    k = crypto.randomBytes(24).toString('hex');
    db.setSetting('unsubscribe_secret', k);
  }
  return k;
}
const unsubToken = (contactId) => crypto.createHmac('sha256', secretKey()).update(`unsubscribe:${contactId}`).digest('base64url').slice(0, 24);
function publicBase() {
  const base = (process.env.APP_URL || db.getSetting('app_url', '') || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  const host = new URL(base).hostname;
  return host === 'localhost' || net.isIP(host) ? null : base;
}
// A one-click link when the CRM is on a public address; otherwise an email
// to the business (or the sender) asking to unsubscribe.
function unsubscribeLink(contactId, senderId = null) {
  const base = publicBase();
  if (base && contactId) return `${base}/api/public/unsubscribe?c=${contactId}&t=${unsubToken(contactId)}`;
  const email = db.getSetting('business_email', '') || (senderId ? db.one('SELECT email FROM users WHERE id = ?', senderId)?.email : null);
  return email ? `mailto:${email}?subject=${encodeURIComponent('Unsubscribe from the newsletter')}` : null;
}
function unsubscribe(contactId, token) {
  const id = Number(contactId);
  if (!Number.isInteger(id) || !token || token.length !== 24) return false;
  const expected = unsubToken(id);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token).padEnd(24).slice(0, 24)))) return false;
  const c = db.one('SELECT id, marketing_opt_in FROM contacts WHERE id = ?', id);
  if (!c) return false;
  if (c.marketing_opt_in) {
    db.update('contacts', id, { marketing_opt_in: 0 });
    db.insert('activities', { contact_id: id, type: 'system', body: 'Unsubscribed from the newsletter (and other marketing emails and texts)' });
  }
  return true;
}

// The email body for one client (or a sample when contact is null).
function render(n, content, contact = null, { senderId = null } = {}) {
  const c = branding.emailColours();
  const rates = content.market_rates || {};
  const checks = contact ? rateCheck(contact.id, rates) : [];
  const owner = contact?.owner_id || senderId;
  const calendly = owner ? require('./templating').bookingLinkFor(owner, contact) : '';
  const website = db.getSetting('business_website', '');
  const bookUrl = calendly || setting('newsletter_booking_url') || (website ? (/^https?:\/\//.test(website) ? website : `https://${website}`) : null);
  const html = [];
  const txt = [];

  html.push(`<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(content.preheader)}</div>`);
  html.push(`<div style="font-family:${FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${c.link};font-weight:bold;margin:0 0 6px 0;">${esc(monthLabel(n.month))} newsletter</div>`);
  html.push(`<h1 style="margin:0 0 14px 0;font-family:${FONT};font-size:26px;line-height:1.25;color:${c.dark};">${esc(content.headline)}</h1>`);
  txt.push(`${monthLabel(n.month).toUpperCase()} NEWSLETTER`, content.headline);
  if (contact?.first_name) { html.push(`<p style="margin:0 0 14px 0;">Hi ${esc(contact.first_name)},</p>`); txt.push(`Hi ${contact.first_name},`); }
  html.push(para(content.intro, c));
  txt.push(content.intro);
  if (content.key_numbers.length) {
    html.push(keyNumbers(content.key_numbers, c));
    txt.push(content.key_numbers.map((k) => `${k.label}: ${k.value}${k.note ? ` (${k.note})` : ''}`).join('\n'));
  }

  // Their rates against the market.
  const averages = RATE_KEYS.filter((k) => rates[k]);
  if (checks.length || averages.length) {
    html.push(heading(checks.length ? 'How does your rate compare?' : 'Average home loan rates this month', c));
    txt.push(checks.length ? 'HOW DOES YOUR RATE COMPARE?' : 'AVERAGE HOME LOAN RATES THIS MONTH');
    if (checks.length) {
      html.push(`<p style="margin:0 0 12px 0;">Here's how ${checks.length > 1 ? 'your loans compare' : 'your loan compares'} with the average rate in the market${rates.as_at ? ` (${esc(rates.as_at)})` : ''}:</p>`);
      for (const r of checks) {
        html.push(rateCard(r, c));
        txt.push(`${r.lender}: your rate ${pct(r.rate)}${r.average ? `, average ${pct(r.average)}${r.yearly && r.diff > 0.05 ? ` (about ${money(r.yearly)} a year more)` : ''}` : ''}`);
      }
      if (checks.some((r) => r.diff > 0.05)) {
        html.push('<p style="margin:4px 0 14px 0;">If your rate is above the average, a quick review could save you money. Lenders often keep their best rates for new customers, but many will sharpen your rate if asked.</p>');
      }
    } else {
      html.push(barChart({ title: 'Average variable and fixed rates', unit: '%', items: averages.map((k) => ({ label: RATE_LABELS[k], value: rates[k] })) }, c));
      txt.push(averages.map((k) => `${RATE_LABELS[k]}: ${pct(rates[k])}`).join('\n'));
    }
    if (rates.source_name) {
      const name = rates.source_url ? `<a href="${esc(rates.source_url)}" style="color:${c.link};">${esc(rates.source_name)}</a>` : esc(rates.source_name);
      html.push(`<p style="margin:-4px 0 14px 0;font-size:12px;color:${MUTED};">Average rates: ${name}${rates.as_at ? `, ${esc(rates.as_at)}` : ''}</p>`);
    }
  }

  for (const s of content.sections) {
    html.push(heading(s.title, c), para(s.body, c));
    txt.push(s.title.toUpperCase(), s.body);
    if (s.chart) {
      html.push(barChart(s.chart, c));
      txt.push(`${s.chart.title}: ${s.chart.items.map((i) => `${i.label} ${fmtValue(i.value, s.chart.unit)}`).join(', ')}`);
    }
    html.push(sourceLine(s.sources, c));
  }

  if (bookUrl) {
    html.push(heading('Let\'s talk', c), '<p style="margin:0 0 6px 0;">Want to check your rate, plan your next purchase or talk through any of this? Book a time that suits you.</p>', button('Book a meeting with me', bookUrl, c));
    txt.push('LET\'S TALK', `Book a meeting: ${bookUrl}`);
  }
  const unsub = unsubscribeLink(contact?.id, owner);
  const unsubHtml = unsub ? ` <a href="${esc(unsub)}" style="color:${MUTED};">Unsubscribe</a>.` : ' To unsubscribe, reply to this email with "unsubscribe".';
  html.push(`<p style="margin:18px 0 0 0;font-size:11px;line-height:1.5;color:${MUTED};">This newsletter is general information only and doesn't take into account your objectives, financial situation or needs. Rate comparisons use the loan details we hold and the averages shown, and are a guide only. Please speak with us before making any decisions.${unsubHtml}</p>`);
  txt.push('This newsletter is general information only and doesn\'t take into account your objectives, financial situation or needs.', unsub ? `Unsubscribe: ${unsub}` : 'To unsubscribe, reply to this email with "unsubscribe".');
  return { subject: content.subject, html: html.join('\n'), text: txt.filter(Boolean).join('\n\n') };
}

// ---- Reading, editing, sending ------------------------------------------------------------------------

function shape(row) {
  if (!row) return null;
  return {
    id: row.id, month: row.month, month_label: monthLabel(row.month), status: row.status, error: row.error, model: row.model,
    usage: row.usage ? JSON.parse(row.usage) : null, generated_at: row.generated_at, updated_at: row.updated_at,
    sent_at: row.sent_at, sent_count: row.sent_count, sent_by_name: row.sent_by_name || null, edited_by_name: row.edited_by_name || null,
    content: row.content ? JSON.parse(row.content) : null,
  };
}
const SELECT = 'SELECT n.*, s.name AS sent_by_name, e.name AS edited_by_name FROM newsletters n LEFT JOIN users s ON s.id = n.sent_by LEFT JOIN users e ON e.id = n.edited_by';
const get = (id) => shape(db.one(`${SELECT} WHERE n.id = ?`, id));
const list = () => db.all(`${SELECT} ORDER BY n.month DESC LIMIT 36`).map((r) => ({ ...shape(r), content: undefined, headline: r.content ? JSON.parse(r.content).headline : null }));

function save(id, content, userId) {
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', id);
  if (!n) throw new HttpError(404, 'Newsletter not found');
  if (n.status === 'sent') throw new HttpError(400, 'This newsletter has already been sent');
  if (n.status === 'generating') throw new HttpError(400, 'Wait for the newsletter to finish being written');
  db.update('newsletters', id, { content: JSON.stringify(clean(content)), status: 'ready', error: null, edited_by: userId, updated_at: nowIso() });
  return get(id);
}

function senderFor(contact, fallbackUserId) {
  const owner = contact?.owner_id ? db.one('SELECT id FROM users WHERE id = ? AND active = 1', contact.owner_id) : null;
  return owner?.id || fallbackUserId;
}

function sendTest(id, user) {
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', id);
  if (!n?.content) throw new HttpError(400, 'There\'s nothing to send yet');
  const content = JSON.parse(n.content);
  // A sample client with loans, so the rate comparison shows.
  const sample = db.one(
    "SELECT c.id, c.first_name, c.last_name, c.email, c.owner_id FROM contacts c JOIN loans l ON l.contact_id = c.id WHERE l.status = 'active' AND l.interest_rate > 0 ORDER BY c.id LIMIT 1",
  );
  const r = render(n, content, sample ? { ...sample, first_name: user.name.split(' ')[0] } : null, { senderId: user.id });
  const outboxId = require('./mailer').queueEmail({
    to: user.email, subject: `[Test] ${r.subject}`, body: r.text, htmlBody: r.html, senderUserId: user.id, internal: true, newsletterId: null,
  });
  return { outboxId, sample: sample ? `${sample.first_name} ${sample.last_name || ''}`.trim() : null };
}

function send(id, userId, { exclude = [] } = {}) {
  const n = db.one('SELECT * FROM newsletters WHERE id = ?', id);
  if (!n) throw new HttpError(404, 'Newsletter not found');
  if (n.status === 'sent') throw new HttpError(400, 'This newsletter has already been sent');
  if (n.status !== 'ready' || !n.content) throw new HttpError(400, 'The newsletter isn\'t ready to send');
  const content = clean(JSON.parse(n.content));
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map(Number));
  const list2 = recipients().filter((r) => !skip.has(r.id));
  if (!list2.length) throw new HttpError(400, 'There\'s no one to send it to');
  const mailer = require('./mailer');
  db.transaction(() => {
    for (const contact of list2) {
      const senderId = senderFor(contact, userId);
      const r = render(n, content, contact, { senderId });
      mailer.queueEmail({ to: contact.email.trim(), subject: r.subject, body: r.text, htmlBody: r.html, contactId: contact.id, senderUserId: senderId, newsletterId: id });
    }
    db.update('newsletters', id, { status: 'sent', sent_at: nowIso(), sent_by: userId, sent_count: list2.length, updated_at: nowIso() });
  });
  mailer.processOutbox().catch(() => {});
  return get(id);
}

function stats(id) {
  return db.all('SELECT status, COUNT(*) AS n FROM outbox WHERE newsletter_id = ? GROUP BY status', id)
    .reduce((o, r) => ({ ...o, [r.status]: r.n }), {});
}

// Email building blocks, shared with other branded emails (e.g. property reports).
const emailParts = { esc, para, heading, keyNumbers, barChart, sourceLine, button, fmtValue, FONT, MUTED, TEXT, BORDER };

module.exports = {
  emailParts,
  SETTING_KEYS, DEFAULT_SOURCES, NEWSLETTER_SCHEMA, RATE_KEYS, RATE_LABELS, settings, saveSettings, reviewers, generate, write, tick, clean,
  recipients, rateCheck, render, get, list, save, send, sendTest, stats, unsubscribe, unsubscribeLink, monthLabel, currentMonth, running,
};
