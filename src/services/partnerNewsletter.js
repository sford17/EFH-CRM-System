'use strict';
// Monthly newsletter for referral partners (agents, accountants, solicitors
// and so on). Two parts: a client story the broker writes (free text, which
// AI can tidy into an anonymised case study), and industry updates that
// Claude researches on the web, each with what it means for the partner's
// clients. Written on the chosen day each month (the 20th by default); the
// broker gets an email reminder to add the story, review it and send it.
const crypto = require('node:crypto');
const db = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const ai = require('./loanDocsAI');
const branding = require('./branding');
const newsletter = require('./newsletter');
const { today, nowIso, formatDate, HttpError } = require('../util');

const { emailParts: E, monthLabel, currentMonth } = newsletter;
const PARTNER_TYPES = ['real_estate', 'buyers_agent', 'solicitor', 'conveyancer', 'accountant', 'financial_planner', 'builder', 'past_client', 'other'];
const TYPE_LABELS = {
  real_estate: 'Real estate agents', buyers_agent: 'Buyer\'s agents', solicitor: 'Solicitors', conveyancer: 'Conveyancers', accountant: 'Accountants',
  financial_planner: 'Financial planners', builder: 'Builders', past_client: 'Past clients who refer', other: 'Other partners',
};
// Industry news sites added to the newsletter's preferred sources for this one.
const EXTRA_SOURCES = ['mpamag.com', 'brokernews.com.au', 'realestatebusiness.com.au', 'accountantsdaily.com.au', 'housing.gov.au', 'revenue.nsw.gov.au', 'sro.vic.gov.au'];
const NUDGE_DAYS = 3;

// ---- Settings ------------------------------------------------------------------------------------------

const DEFAULTS = { partner_newsletter_enabled: '1', partner_newsletter_day: '20', partner_newsletter_types: PARTNER_TYPES.join(',') };
const setting = (k) => db.getSetting(k, DEFAULTS[k]) ?? DEFAULTS[k];

function settings() {
  return {
    enabled: setting('partner_newsletter_enabled') !== '0',
    day: Math.min(28, Math.max(1, Number(setting('partner_newsletter_day')) || 20)),
    types: setting('partner_newsletter_types').split(',').filter((t) => PARTNER_TYPES.includes(t)),
    reviewers: newsletter.reviewers().map((u) => u.id),
  };
}

function saveSettings(body = {}) {
  if (body.enabled !== undefined) db.setSetting('partner_newsletter_enabled', body.enabled ? '1' : '0');
  if (body.day !== undefined) {
    const d = Number(body.day);
    if (!Number.isInteger(d) || d < 1 || d > 28) throw new HttpError(400, 'Choose a day from 1 to 28');
    db.setSetting('partner_newsletter_day', String(d));
  }
  if (body.types !== undefined) {
    const t = (Array.isArray(body.types) ? body.types : String(body.types).split(',')).filter((x) => PARTNER_TYPES.includes(x));
    if (!t.length) throw new HttpError(400, 'Choose which partners receive it');
    db.setSetting('partner_newsletter_types', t.join(','));
  }
  return settings();
}

// ---- Content -------------------------------------------------------------------------------------------

const text = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const httpsUrl = (u) => {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
const sources = (list) => (Array.isArray(list) ? list : []).map((s) => ({ title: text(s?.title, 200), publisher: text(s?.publisher, 80), url: httpsUrl(s?.url) }))
  .filter((s) => s.url && s.title).slice(0, 8);
const pairs = (list, n) => (Array.isArray(list) ? list : []).map((k) => ({ label: text(k?.label, 60), value: text(k?.value, 40) })).filter((k) => k.label && k.value).slice(0, n);

const emptyContent = (month) => ({
  subject: `${monthLabel(month)} partner update`, preheader: '', headline: `${monthLabel(month)} partner update`, intro: '',
  scenario: { title: '', body: '', highlights: [] }, key_numbers: [], updates: [],
  closing: 'If you know someone who\'s buying, refinancing or wants a second opinion on their loan, I\'d love to help – and I\'ll keep you in the loop all the way through.',
  notes_for_broker: [],
});

// Keeps what's well-formed (from the AI or the broker's edits).
function clean(c = {}, month = currentMonth()) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'The newsletter content is missing');
  const base = emptyContent(month);
  return {
    subject: text(c.subject, 150) || base.subject,
    preheader: text(c.preheader, 200),
    headline: text(c.headline, 200) || base.headline,
    intro: text(c.intro, 3000),
    scenario: { title: text(c.scenario?.title, 150), body: text(c.scenario?.body, 6000), highlights: pairs(c.scenario?.highlights, 4) },
    key_numbers: (Array.isArray(c.key_numbers) ? c.key_numbers : []).map((k) => ({ label: text(k?.label, 60), value: text(k?.value, 30), note: text(k?.note, 120) }))
      .filter((k) => k.label && k.value).slice(0, 4),
    updates: (Array.isArray(c.updates) ? c.updates : []).map((u) => {
      const items = Array.isArray(u?.chart?.items) ? u.chart.items.map((i) => ({ label: text(i?.label, 40), value: Number(i?.value) })).filter((i) => i.label && Number.isFinite(i.value)).slice(0, 12) : [];
      return {
        title: text(u?.title, 150), body: text(u?.body, 5000), for_clients: text(u?.for_clients, 1500),
        chart: items.length >= 2 ? { title: text(u.chart.title, 150), unit: ['%', '$', 'number'].includes(u.chart.unit) ? u.chart.unit : 'number', items } : null,
        sources: sources(u?.sources),
      };
    }).filter((u) => u.title && u.body).slice(0, 6),
    closing: typeof c.closing === 'string' ? text(c.closing, 1500) : base.closing,
    notes_for_broker: (Array.isArray(c.notes_for_broker) ? c.notes_for_broker : []).map((n) => text(n, 400)).filter(Boolean).slice(0, 20),
  };
}

// What still needs doing before it can go out.
function missing(content) {
  const out = [];
  if (!content.scenario.body) out.push('this month\'s client story');
  if (!content.updates.length) out.push('at least one industry update');
  return out;
}

// ---- AI: industry updates (web research) and tidying the client story --------------------------------------

const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const SOURCE = { type: 'object', additionalProperties: false, required: ['title', 'publisher', 'url'], properties: { title: { type: 'string' }, publisher: { type: 'string' }, url: { type: 'string' } } };
const PAIR = { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } };
const STORY = {
  type: 'object', additionalProperties: false, required: ['title', 'body', 'highlights'],
  properties: {
    title: { type: 'string', description: 'A short headline for the story, e.g. "From renting to owning with a 5% deposit"' },
    body: { type: 'string', description: 'The anonymised story in 2–4 short paragraphs separated by blank lines: the situation, the challenge, what we did, the result' },
    highlights: { type: 'array', description: 'Up to 4 headline facts from the notes, e.g. {label: "Deposit", value: "5%"}', items: PAIR },
  },
};
const UPDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subject', 'preheader', 'headline', 'intro', 'key_numbers', 'updates', 'scenario', 'notes_for_broker'],
  properties: {
    subject: { type: 'string', description: 'Email subject, under 70 characters' },
    preheader: { type: 'string', description: 'Inbox preview line, under 110 characters' },
    headline: { type: 'string' },
    intro: { type: 'string', description: 'One or two short paragraphs from the broker to their referral partners' },
    key_numbers: { type: 'array', description: '3 headline figures, e.g. cash rate, national home value change, first home buyer lending', items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'note'], properties: { label: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } } } },
    updates: {
      type: 'array', description: '3 or 4 industry updates',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'body', 'for_clients', 'chart', 'sources'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Short paragraphs; lines starting "- " are bullet points' },
          for_clients: { type: 'string', description: 'One or two sentences: what this means for the partner\'s clients (buyers, sellers, business owners)' },
          chart: nullable({
            type: 'object', additionalProperties: false, required: ['title', 'unit', 'items'],
            properties: { title: { type: 'string' }, unit: { type: 'string', enum: ['%', '$', 'number'] }, items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'number' } } } } },
          }, 'Optional bar chart of figures from your sources; null if nothing is worth charting'),
          sources: { type: 'array', items: SOURCE },
        },
      },
    },
    scenario: nullable(STORY, 'The client story written from the broker\'s notes, or null if no notes were given'),
    notes_for_broker: { type: 'array', items: { type: 'string' } },
  },
};

const PRIVACY_RULES = `- Protect the client's privacy: no real names (use a description like "a young couple" or a clearly made-up first name), no street addresses, employers or anything that could identify them. Suburbs or regions are fine.
- Keep to the facts in the broker's notes. Don't invent figures, lenders or outcomes; if something is unclear, leave it out and mention it in notes_for_broker.
- General information only: don't promise rates or approvals, and don't recommend a specific lender as best for everyone.`;

function systemPrompt(month, business) {
  return `You write the monthly referral partner newsletter for ${business || 'an Australian mortgage broking business'}. Readers are the broker's referral partners: real estate agents, buyer's agents, accountants, solicitors, conveyancers, financial planners and builders. They want short, useful updates they can pass on to their own clients, and a reminder of how the broker helps.

Research ${monthLabel(month)}'s news with web search, then call save_partner_newsletter once.

Industry updates (3 or 4) could cover:
- Interest rates and the RBA, and what lenders are doing.
- Lending policy changes (serviceability, LVR limits, self-employed and investor lending, credit policy).
- Government schemes and stamp duty or grant changes (e.g. first home buyer schemes).
- The property market: values, clearance rates, listings, rents.
Each update needs a "for_clients" line: what it means for the partner's clients.

${'If the broker gave notes about a client they helped, also write the client story (scenario) from them:'}
${PRIVACY_RULES}

Rules:
- Every figure must come from a source you found; list the pages in each update's sources. Don't invent numbers.
- Write in your own words, in warm, plain Australian English. Short paragraphs, professional but friendly – one professional to another.
- Put anything uncertain or worth checking in notes_for_broker.`;
}

async function callClaude({ system, user, tool, web = false, effort = 'high' }) {
  const client = ai.clientFor();
  const domains = [...new Set([...newsletter.settings().sources, ...EXTRA_SOURCES])];
  const tools = [
    ...(web ? [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 12, user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' }, allowed_domains: domains },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, allowed_domains: domains },
    ] : []),
    { ...tool, strict: true, eager_input_streaming: true },
  ];
  const messages = [{ role: 'user', content: user }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let model = ai.model();
  for (let turn = 0; turn < 8; turn += 1) {
    let message;
    try {
      message = await client.beta.messages.stream({
        model: ai.model(), max_tokens: 32000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        thinking: { type: 'adaptive' }, output_config: { effort }, system, tools, tool_choice: { type: 'auto' }, messages,
      }).finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      messages.push({ role: 'user', content: `That didn't come through complete. Please call ${tool.name} again.` });
      continue;
    }
    model = message.model || model;
    usage.input_tokens += message.usage?.input_tokens || 0;
    usage.output_tokens += message.usage?.output_tokens || 0;
    usage.web_searches += message.usage?.server_tool_use?.web_search_requests || 0;
    if (message.stop_reason === 'refusal') throw new HttpError(502, 'The AI service declined this time. Try again, or write it yourself.');
    if (message.stop_reason === 'max_tokens') throw new HttpError(502, 'It came out too long. Try again.');
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue;
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!call) {
      messages.push({ role: 'user', content: `Please call ${tool.name} now.` });
      continue;
    }
    if (!call.input || typeof call.input !== 'object') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: 'Send the complete object' }) }] });
      continue;
    }
    return { input: call.input, model, usage };
  }
  throw new HttpError(502, 'The AI service didn\'t finish. Try again.');
}

async function write(month, notes) {
  const business = db.getSetting('business_name', '');
  const r = await callClaude({
    system: systemPrompt(month, business),
    user: `Please research and write the ${monthLabel(month)} partner newsletter. Today is ${formatDate(today())}.\n\n${notes ? `The broker's notes about a client they helped this month (write the scenario from these):\n<notes>\n${notes}\n</notes>` : 'The broker hasn\'t written this month\'s client story yet, so set scenario to null.'}`,
    tool: { name: 'save_partner_newsletter', description: 'Save the finished partner newsletter. Call once, after your research.', input_schema: UPDATE_SCHEMA },
    web: true,
  });
  const c = clean({ ...emptyContent(month), ...r.input, scenario: r.input.scenario || { title: '', body: '', highlights: [] } }, month);
  return { content: c, model: r.model, usage: r.usage };
}

// Turns the broker's rough notes into a short, anonymised client story.
async function polishScenario(notes) {
  const raw = text(notes, 6000);
  if (raw.length < 20) throw new HttpError(400, 'Write a few sentences about the client first');
  if (!ai.configured()) throw new HttpError(400, 'AI isn\'t set up yet. An admin can add an Anthropic API key in Settings → AI.');
  const business = db.getSetting('business_name', '');
  const r = await callClaude({
    system: `You turn a mortgage broker's rough notes into a short client success story for the newsletter ${business || 'the broker'} sends to referral partners (agents, accountants, solicitors).\n\n${PRIVACY_RULES}\n- Plain, warm Australian English: the situation, the challenge, what the broker did, the result. 120–220 words.\n- Call save_story once.`,
    user: `<notes>\n${raw}\n</notes>`,
    tool: { name: 'save_story', description: 'Save the client story.', input_schema: STORY },
    effort: 'medium',
  });
  return { title: text(r.input.title, 150), body: text(r.input.body, 6000), highlights: pairs(r.input.highlights, 4) };
}

// ---- Ideas for the story: recent settlements, with nothing identifying ----------------------------------

const PURPOSE_WORDS = {
  first_home: 'First home buyers', purchase: 'Home buyers', investment: 'An investor', refinance: 'A refinance client', construction: 'Clients building a home',
  top_up: 'Clients accessing equity', commercial: 'A business owner', other: 'A client',
};
const dollars = (n) => (n ? `$${Math.round(n).toLocaleString('en-AU')}` : null);
function ideas() {
  const rows = db.all(`SELECT d.id, d.loan_purpose, d.loan_amount, d.property_value, d.deposit, d.property_address, d.co_borrower_id, d.created_at, d.settlement_date,
      COALESCE(l.name, '') AS lender, c.employment_type,
      (SELECT MAX(changed_at) FROM deal_stage_history h WHERE h.deal_id = d.id AND h.to_stage = 'settled') AS settled_at,
      p.name AS partner_name
    FROM deals d JOIN contacts c ON c.id = d.contact_id LEFT JOIN lenders l ON l.id = d.lender_id LEFT JOIN referral_partners p ON p.id = d.referral_partner_id
    WHERE d.stage = 'settled' ORDER BY COALESCE(d.settlement_date, d.updated_at) DESC LIMIT 8`);
  return rows.map((d) => {
    const who = d.co_borrower_id && ['first_home', 'purchase'].includes(d.loan_purpose) ? `${PURPOSE_WORDS[d.loan_purpose]} (a couple)` : PURPOSE_WORDS[d.loan_purpose] || 'A client';
    const suburb = (/,\s*([A-Za-z][A-Za-z' -]+?)\s+(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i.exec(d.property_address || '') || [])[1];
    const lvr = d.loan_amount && d.property_value ? Math.round((d.loan_amount / d.property_value) * 100) : null;
    const days = d.settled_at ? Math.max(1, Math.round((Date.parse(d.settled_at) - Date.parse(d.created_at)) / 86400000)) : null;
    const parts = [
      `${who}${d.employment_type === 'self_employed' ? ', self-employed,' : ''} ${d.loan_purpose === 'refinance' ? 'refinanced' : d.loan_purpose === 'top_up' ? 'accessed equity' : 'bought'}${suburb ? ` in ${suburb}` : ''}${d.property_value ? ` (property ${dollars(d.property_value)})` : ''}.`,
      d.loan_amount ? `Loan of ${dollars(d.loan_amount)}${lvr ? ` (${lvr}% LVR)` : ''}${d.lender ? ` with ${d.lender}` : ''}.` : null,
      days ? `${days} days from starting with us to settlement.` : null,
      'Challenge: … What we did: … Result: …',
    ].filter(Boolean);
    return { deal_id: d.id, label: `${who} · ${dollars(d.loan_amount) || '–'}${d.lender ? ` · ${d.lender}` : ''}${d.settlement_date ? ` · settled ${formatDate(d.settlement_date)}` : ''}`, referred_by: d.partner_name || null, notes: parts.join(' ') };
  });
}

// ---- Records ---------------------------------------------------------------------------------------------

function shape(row) {
  if (!row) return null;
  return {
    id: row.id, month: row.month, month_label: monthLabel(row.month), status: row.status, error: row.error, scenario_notes: row.scenario_notes || '',
    usage: row.usage ? JSON.parse(row.usage) : null, generated_at: row.generated_at, updated_at: row.updated_at,
    sent_at: row.sent_at, sent_count: row.sent_count, sent_by_name: row.sent_by_name || null, edited_by_name: row.edited_by_name || null,
    content: row.content ? JSON.parse(row.content) : null,
  };
}
const SELECT = 'SELECT n.*, s.name AS sent_by_name, e.name AS edited_by_name FROM partner_newsletters n LEFT JOIN users s ON s.id = n.sent_by LEFT JOIN users e ON e.id = n.edited_by';
const get = (id) => shape(db.one(`${SELECT} WHERE n.id = ?`, id));
const list = () => db.all(`${SELECT} ORDER BY n.month DESC LIMIT 36`).map((r) => {
  const s = shape(r);
  return { ...s, content: undefined, headline: s.content?.headline || null, has_story: Boolean(s.content?.scenario?.body || s.scenario_notes) };
});
function load(id) {
  const r = db.one('SELECT * FROM partner_newsletters WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Newsletter not found');
  return r;
}

// This month's newsletter, started as a draft so the story can be written early.
function draft(month = currentMonth()) {
  const existing = db.one('SELECT id FROM partner_newsletters WHERE month = ?', month);
  return get(existing ? existing.id : db.insert('partner_newsletters', { month, status: 'draft' }));
}

function saveNotes(id, notes, userId) {
  const r = load(id);
  if (r.status === 'sent') throw new HttpError(400, 'This newsletter has already been sent');
  db.update('partner_newsletters', id, { scenario_notes: text(notes, 6000), edited_by: userId, updated_at: nowIso() });
  return get(id);
}

function save(id, content, userId) {
  const r = load(id);
  if (r.status === 'sent') throw new HttpError(400, 'This newsletter has already been sent');
  if (r.status === 'generating') throw new HttpError(400, 'Wait for the updates to finish being written');
  db.update('partner_newsletters', id, { content: JSON.stringify(clean(content, r.month)), status: 'ready', error: null, edited_by: userId, updated_at: nowIso() });
  return get(id);
}

const running = new Set();

// Writes the industry updates (and the story, from the broker's notes) in the background.
function generate(month = currentMonth(), { regenerate = false } = {}) {
  const row = db.one('SELECT * FROM partner_newsletters WHERE month = ?', month);
  if (row?.status === 'generating' || running.has(month)) throw new HttpError(400, 'It\'s already being written');
  if (row?.status === 'sent') throw new HttpError(400, 'This month\'s partner newsletter has already been sent');
  if (row?.status === 'ready' && !regenerate) throw new HttpError(400, 'This month\'s partner newsletter is already written');
  const id = row ? row.id : db.insert('partner_newsletters', { month, status: 'draft' });
  const notes = row?.scenario_notes || '';
  if (!ai.configured()) {
    // No AI: start an empty newsletter (with the broker's story as written) to fill in by hand.
    const content = emptyContent(month);
    content.scenario.body = notes;
    db.update('partner_newsletters', id, { status: 'ready', content: JSON.stringify(content), generated_at: nowIso(), error: 'AI isn\'t set up, so the industry updates need writing by hand.', updated_at: nowIso() });
    notifyReady(id);
    return { id, done: Promise.resolve() };
  }
  db.update('partner_newsletters', id, { status: 'generating', error: null, updated_at: nowIso() });
  running.add(month);
  const done = (async () => {
    try {
      const r = await write(month, notes);
      const keep = row?.content && regenerate ? JSON.parse(row.content) : null;
      // When rewriting, keep a story the broker has already finished.
      if (keep?.scenario?.body && !notes) r.content.scenario = keep.scenario;
      db.update('partner_newsletters', id, { status: 'ready', content: JSON.stringify(r.content), model: r.model, usage: JSON.stringify(r.usage), generated_at: nowIso(), error: null, updated_at: nowIso() });
      notifyReady(id);
    } catch (err) {
      const message = newsletter.friendly(err);
      db.update('partner_newsletters', id, { status: row?.content ? 'ready' : 'failed', error: message, updated_at: nowIso() });
      for (const u of newsletter.reviewers()) db.insert('notifications', { user_id: u.id, message: `The ${monthLabel(month)} partner newsletter couldn't be written: ${message}`, link: `#/partner-newsletters/${id}` });
    } finally {
      running.delete(month);
    }
  })();
  return { id, done };
}

// The email reminder to review it (and add the story if it's missing).
function notifyReady(id) {
  const n = get(id);
  const c = n.content;
  const link = require('./reminders').crmUrl(`#/partner-newsletters/${id}`);
  const todo = missing(c);
  const count = recipients().length;
  for (const u of newsletter.reviewers()) {
    db.insert('notifications', { user_id: u.id, message: `Your ${n.month_label} partner newsletter is ready${todo.length ? ` – add ${todo.join(' and ')}` : ' to review'}`, link: `#/partner-newsletters/${id}` });
    if (!u.email) continue;
    require('./mailer').queueEmail({
      to: u.email,
      subject: todo.includes('this month\'s client story') ? `Reminder: add a client story to your ${n.month_label} partner newsletter` : `Your ${n.month_label} partner newsletter is ready to review`,
      body: [
        `Hi ${u.name.split(' ')[0]},`,
        `Your ${n.month_label} referral partner newsletter is ready.`,
        c.updates.length ? `Industry updates:\n${c.updates.map((x) => `- ${x.title}`).join('\n')}` : 'The industry updates still need writing.',
        c.scenario.body ? `Client story: ${c.scenario.title || 'written'}` : 'It still needs this month\'s client story – a scenario where you helped a client. Write a few sentences and AI can tidy it up (no names needed).',
        c.notes_for_broker.length ? `Please double-check:\n${c.notes_for_broker.map((x) => `- ${x}`).join('\n')}` : null,
        `When you're happy with it, send it to your ${count} referral partner${count === 1 ? '' : 's'}. Nothing goes out until you press Send.`,
        `[[button: Open the partner newsletter | ${link}]]`,
      ].filter(Boolean).join('\n\n'),
      senderUserId: u.id,
      internal: true,
    });
  }
  require('./mailer').processOutbox().catch(() => {});
}

// A heads-up a few days before, if no story has been written for the month.
function nudge(month) {
  const n = draft(month);
  if (n.scenario_notes || n.content?.scenario?.body) return false;
  const link = require('./reminders').crmUrl(`#/partner-newsletters/${n.id}`);
  for (const u of newsletter.reviewers()) {
    db.insert('notifications', { user_id: u.id, message: `Add a client story for the ${n.month_label} partner newsletter`, link: `#/partner-newsletters/${n.id}` });
    if (!u.email) continue;
    require('./mailer').queueEmail({
      to: u.email,
      subject: `Your partner newsletter goes out soon: add a client story`,
      body: [`Hi ${u.name.split(' ')[0]},`,
        `Your ${n.month_label} partner newsletter will be written on the ${settings().day}${[, 'st', 'nd', 'rd'][(settings().day % 100 >> 3) ^ 1 && settings().day % 10] || 'th'}. Would you like to add a client you've helped recently? A few sentences is plenty (no names needed), and AI can tidy it up.`,
        `[[button: Write the client story | ${link}]]`].join('\n\n'),
      senderUserId: u.id,
      internal: true,
    });
  }
  return true;
}

// Scheduler: a nudge a few days before the day, then the newsletter on the day.
function tick(now = today()) {
  const s = settings();
  if (!s.enabled) return null;
  const month = now.slice(0, 7);
  const day = Number(now.slice(8, 10));
  const row = db.one('SELECT * FROM partner_newsletters WHERE month = ?', month);
  if (day >= s.day) {
    if (row && row.status !== 'draft') return null;
    return generate(month);
  }
  if (day >= s.day - NUDGE_DAYS && db.getSetting('partner_newsletter_nudged', '') !== month) {
    db.setSetting('partner_newsletter_nudged', month);
    nudge(month);
  }
  return null;
}

// ---- Who gets it --------------------------------------------------------------------------------------

function recipients() {
  const types = settings().types;
  const rows = db.all(`SELECT id, name, company, type, email FROM referral_partners
    WHERE active = 1 AND newsletter_opt_in = 1 AND email IS NOT NULL AND trim(email) != '' AND type IN (${types.map(() => '?').join(',')})
    ORDER BY id`, ...types);
  // One copy per email address (the partner added first keeps it).
  const seen = new Set();
  return rows.filter((r) => {
    const key = r.email.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

// ---- Unsubscribe ---------------------------------------------------------------------------------------

const unsubToken = (partnerId) => crypto.createHmac('sha256', newsletter.secretKey()).update(`partner-unsubscribe:${partnerId}`).digest('base64url').slice(0, 24);
function unsubscribeLink(partnerId, senderEmail) {
  const base = newsletter.publicBase();
  if (base && partnerId) return `${base}/api/public/partner-unsubscribe?p=${partnerId}&t=${unsubToken(partnerId)}`;
  const email = db.getSetting('business_email', '') || senderEmail;
  return email ? `mailto:${email}?subject=${encodeURIComponent('Unsubscribe from the partner newsletter')}` : null;
}
function unsubscribe(partnerId, token) {
  const id = Number(partnerId);
  if (!Number.isInteger(id) || !token || String(token).length !== 24) return false;
  if (!crypto.timingSafeEqual(Buffer.from(unsubToken(id)), Buffer.from(String(token)))) return false;
  const p = db.one('SELECT id FROM referral_partners WHERE id = ?', id);
  if (!p) return false;
  db.update('referral_partners', id, { newsletter_opt_in: 0 });
  return true;
}

// ---- The email -----------------------------------------------------------------------------------------

function callout(t, c) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px 0;"><tr>
<td bgcolor="${c.soft}" style="background:${c.soft};border-left:4px solid ${c.primary};border-radius:4px;padding:10px 14px;font-family:${E.FONT};font-size:14px;line-height:1.5;color:${E.TEXT};"><strong style="color:${c.dark};">For your clients:</strong> ${E.esc(t)}</td></tr></table>`;
}

function render(n, content, partner = null, { sender = null } = {}) {
  const c = branding.emailColours();
  const html = [];
  const txt = [];
  const first = partner?.name ? partner.name.trim().split(/\s+/)[0] : null;
  const s = content.scenario;
  html.push(`<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${E.esc(content.preheader)}</div>`);
  html.push(`<div style="font-family:${E.FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${c.link};font-weight:bold;margin:0 0 6px 0;">${E.esc(monthLabel(n.month))} partner update</div>`);
  html.push(`<h1 style="margin:0 0 14px 0;font-family:${E.FONT};font-size:26px;line-height:1.25;color:${c.dark};">${E.esc(content.headline)}</h1>`);
  txt.push(`${monthLabel(n.month).toUpperCase()} PARTNER UPDATE`, content.headline);
  if (first) { html.push(`<p style="margin:0 0 14px 0;">Hi ${E.esc(first)},</p>`); txt.push(`Hi ${first},`); }
  if (content.intro) { html.push(E.para(content.intro, c)); txt.push(content.intro); }
  if (content.key_numbers.length) {
    html.push(E.keyNumbers(content.key_numbers, c));
    txt.push(content.key_numbers.map((k) => `${k.label}: ${k.value}${k.note ? ` (${k.note})` : ''}`).join('\n'));
  }
  if (s.body) {
    html.push(E.heading(s.title ? `Client story: ${s.title}` : 'How we helped a client this month', c));
    txt.push((s.title ? `CLIENT STORY: ${s.title}` : 'HOW WE HELPED A CLIENT THIS MONTH').toUpperCase());
    if (s.highlights.length) {
      html.push(E.keyNumbers(s.highlights.map((x) => ({ ...x, note: '' })), c));
      txt.push(s.highlights.map((x) => `${x.label}: ${x.value}`).join(' · '));
    }
    html.push(E.para(s.body, c), `<p style="margin:-6px 0 14px 0;font-size:12px;color:${E.MUTED};">Details changed to protect our client's privacy.</p>`);
    txt.push(s.body);
  }
  if (content.updates.length) {
    html.push(E.heading('Industry updates', c));
    txt.push('INDUSTRY UPDATES');
    for (const u of content.updates) {
      html.push(`<h3 style="margin:16px 0 8px 0;font-family:${E.FONT};font-size:16px;color:${c.dark};">${E.esc(u.title)}</h3>`, E.para(u.body, c));
      txt.push(u.title, u.body);
      if (u.for_clients) { html.push(callout(u.for_clients, c)); txt.push(`For your clients: ${u.for_clients}`); }
      if (u.chart) html.push(E.barChart(u.chart, c));
      html.push(E.sourceLine(u.sources, c));
    }
  }
  const senderEmail = sender?.email || db.getSetting('business_email', '');
  html.push(E.heading('Know someone we could help?', c));
  txt.push('KNOW SOMEONE WE COULD HELP?');
  if (content.closing) { html.push(E.para(content.closing, c)); txt.push(content.closing); }
  if (senderEmail) {
    const subject = `Referral${partner?.name ? ` from ${partner.name}` : ''}`;
    const body = 'Hi,\n\nI\'d like to introduce a client:\n\nName:\nPhone:\nEmail:\nWhat they need:\n\nThanks!';
    const mailto = `mailto:${senderEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    html.push(E.button('Refer a client', mailto, c));
    txt.push(`Refer a client: email ${senderEmail}${sender?.phone ? ` or call ${sender.phone}` : ''}`);
  }
  const booking = sender?.id ? require('./templating').bookingLinkFor(sender.id, null) : '';
  const bookUrl = booking || newsletter.settings().booking_url;
  if (bookUrl) {
    html.push(`<p style="margin:0 0 14px 0;">Or <a href="${E.esc(bookUrl)}" style="color:${c.link};">book a catch-up</a> to talk about how we can work together.</p>`);
    txt.push(`Book a catch-up: ${bookUrl}`);
  }
  const unsub = unsubscribeLink(partner?.id, senderEmail);
  const unsubHtml = unsub ? ` <a href="${E.esc(unsub)}" style="color:${E.MUTED};">Unsubscribe</a>.` : ' To unsubscribe, reply with "unsubscribe".';
  html.push(`<p style="margin:18px 0 0 0;font-size:11px;line-height:1.5;color:${E.MUTED};">You're receiving this as one of our referral partners. It's general information only and doesn't take into account anyone's objectives, financial situation or needs.${unsubHtml}</p>`);
  txt.push('General information only.', unsub ? `Unsubscribe: ${unsub}` : 'To unsubscribe, reply with "unsubscribe".');
  return { subject: content.subject, html: html.join('\n'), text: txt.filter(Boolean).join('\n\n') };
}

// ---- Sending --------------------------------------------------------------------------------------------

function readyContent(id) {
  const r = load(id);
  if (r.status === 'sent') throw new HttpError(400, 'This newsletter has already been sent');
  if (r.status !== 'ready' || !r.content) throw new HttpError(400, 'The newsletter isn\'t ready yet');
  return { row: r, content: clean(JSON.parse(r.content), r.month) };
}

function sendTest(id, user) {
  const { row, content } = readyContent(id);
  const r = render(row, content, { id: null, name: user.name }, { sender: db.one('SELECT id, name, email, phone FROM users WHERE id = ?', user.id) });
  return require('./mailer').queueEmail({ to: user.email, subject: `[Test] ${r.subject}`, body: r.text, htmlBody: r.html, senderUserId: user.id, internal: true });
}

function send(id, userId, { exclude = [] } = {}) {
  const { row, content } = readyContent(id);
  const todo = missing(content);
  if (todo.length) throw new HttpError(400, `Add ${todo.join(' and ')} first`);
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map(Number));
  const to = recipients().filter((p) => !skip.has(p.id));
  if (!to.length) throw new HttpError(400, 'There\'s no one to send it to. Add email addresses to your referral partners.');
  const sender = db.one('SELECT id, name, email, phone FROM users WHERE id = ?', userId);
  const mailer = require('./mailer');
  db.transaction(() => {
    for (const p of to) {
      const r = render(row, content, p, { sender });
      mailer.queueEmail({ to: p.email.trim(), subject: r.subject, body: r.text, htmlBody: r.html, senderUserId: userId, partnerId: p.id, partnerNewsletterId: id });
    }
    db.update('partner_newsletters', id, { status: 'sent', sent_at: nowIso(), sent_by: userId, sent_count: to.length, updated_at: nowIso() });
  });
  mailer.processOutbox().catch(() => {});
  return get(id);
}

function stats(id) {
  return db.all('SELECT status, COUNT(*) AS n FROM outbox WHERE partner_newsletter_id = ? GROUP BY status', id).reduce((o, r) => ({ ...o, [r.status]: r.n }), {});
}

function remove(id) {
  const r = load(id);
  if (r.status === 'sent') throw new HttpError(400, 'Sent newsletters are kept as a record');
  if (r.status === 'generating') throw new HttpError(400, 'Wait for it to finish being written');
  return db.run('DELETE FROM partner_newsletters WHERE id = ?', id).changes > 0;
}

module.exports = {
  PARTNER_TYPES, TYPE_LABELS, settings, saveSettings, clean, missing, write, polishScenario, ideas, get, list, draft, saveNotes, save, generate, tick, nudge,
  recipients, unsubscribe, unsubscribeLink, render, sendTest, send, stats, remove, running, emptyContent,
};
