'use strict';
// Lead generator: Claude searches the web for potential leads matching the
// broker's request: businesses and professionals (e.g. real estate agents,
// accountants, builders, businesses that may need lending), using contact
// details they publish themselves. Results are reviewed, then added to the
// CRM as leads or referral partners. Nothing is contacted automatically.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const ai = require('./loanDocsAI');
const { today, nowIso, formatDate, HttpError } = require('../util');

const CATEGORIES = {
  real_estate: 'Real estate agent', buyers_agent: 'Buyer\'s agent', accountant: 'Accountant', financial_planner: 'Financial planner',
  solicitor: 'Solicitor', conveyancer: 'Conveyancer', builder: 'Builder / developer', business: 'Business (possible client)',
  professional: 'Professional (possible client)', other: 'Other',
};
const PARTNER_TYPES = ['real_estate', 'buyers_agent', 'solicitor', 'conveyancer', 'accountant', 'financial_planner', 'builder'];
const LEAD_TYPES = { any: 'Leads or referral partners', referral_partner: 'Referral partners', business: 'Business clients' };

const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });
const str = { type: 'string' };
const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['leads', 'search_notes'],
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'organisation', 'role', 'category', 'suburb', 'state', 'website', 'email', 'phone', 'source_url', 'source_title', 'relevance', 'outreach_tip'],
        properties: {
          name: { type: 'string', description: 'The person\'s name if a named professional is the lead, otherwise the business name' },
          organisation: nullable(str, 'Business or agency name'),
          role: nullable(str, 'e.g. Sales agent, Principal, Director, Partner'),
          category: { type: 'string', enum: Object.keys(CATEGORIES) },
          suburb: nullable(str), state: nullable({ type: 'string', enum: ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] }),
          website: nullable(str, 'Their own website (https)'),
          email: nullable(str, 'Only an email address the business itself publishes for enquiries (on its own website or official listing)'),
          phone: nullable(str, 'Only a business phone number they publish'),
          source_url: { type: 'string', description: 'The page where you found them (https)' },
          source_title: str,
          relevance: { type: 'string', description: 'One or two sentences: why they match the broker\'s request' },
          outreach_tip: { type: 'string', description: 'A short, specific idea for a respectful first approach' },
        },
      },
    },
    search_notes: { type: 'array', items: str, description: 'Brief notes for the broker: what you searched, gaps, anything to check' },
  },
};

const SAVE_TOOL = {
  name: 'save_leads',
  description: 'Save the leads you found. Call this once, at the end, with every lead.',
  strict: true,
  eager_input_streaming: true,
  input_schema: LEAD_SCHEMA,
};

function systemPrompt(s, business) {
  return `You find potential business leads for ${business || 'an Australian mortgage broker'}, a mortgage broker in Australia. Search the web for what the broker asks for, then call save_leads once with what you found.

Who to find:
- Businesses and professionals, e.g. referral partners (real estate agents, buyer's agents, accountants, financial planners, solicitors, conveyancers, builders and developers) or businesses and professionals who might need home or commercial lending.
- Up to ${s.max_results} leads that genuinely match the request${s.location ? `, in or near ${s.location}` : ''}. Quality over quantity; don't pad the list.

Privacy and spam rules (Australia):
- Only use contact details a business or professional publishes themselves for business enquiries (their own website, agency profile, or official directory listing). Never collect personal mobile numbers or emails from social media, forums, reviews, leaked lists or people-search sites.
- Don't include private individuals (e.g. people posting that they're looking to buy). Professionals acting in their business role are fine.
- Leave email or phone as null if it isn't published for business enquiries.

Accuracy:
- Every lead must come from a page you actually found; give that page as source_url. Don't invent names, emails or numbers.
- Prefer current listings; skip businesses that look closed.
- In relevance, say concretely why they fit (e.g. "Lists 40+ first-home sales in Parramatta this year"). In outreach_tip, suggest a respectful, specific first approach (e.g. a phone call or LinkedIn message about a shared client type), not a mass email.

Today is ${formatDate(today())}.`;
}

// ---- Cleaning what the AI returns ------------------------------------------------------------

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null) || null;
const httpsUrl = (u) => {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};
const email = (e) => (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : null);
const phone = (p) => {
  const s = typeof p === 'string' ? p.trim() : '';
  return s.replace(/\D/g, '').length >= 8 && s.replace(/\D/g, '').length <= 12 ? s.slice(0, 30) : null;
};
const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
};
const digits = (p) => (p ? p.replace(/\D/g, '').replace(/^61/, '0') : '');

function clean(raw = {}) {
  const leads = (Array.isArray(raw.leads) ? raw.leads : []).map((l) => ({
    name: text(l?.name, 120),
    organisation: text(l?.organisation, 120),
    role: text(l?.role, 80),
    category: Object.hasOwn(CATEGORIES, l?.category) ? l.category : 'other',
    suburb: text(l?.suburb, 60),
    state: ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].includes(l?.state) ? l.state : null,
    website: httpsUrl(l?.website),
    email: email(l?.email),
    phone: phone(l?.phone),
    source_url: httpsUrl(l?.source_url),
    source_title: text(l?.source_title, 200),
    relevance: text(l?.relevance, 600),
    outreach_tip: text(l?.outreach_tip, 600),
  })).filter((l) => l.name && l.source_url);
  // The same business found twice.
  const seen = new Set();
  const unique = leads.filter((l) => {
    const key = l.email || digits(l.phone) || `${(l.name || '').toLowerCase()}|${(l.organisation || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { leads: unique.map((l, i) => ({ id: i + 1, ...l, status: 'new' })), notes: (Array.isArray(raw.search_notes) ? raw.search_notes : []).map((n) => text(n, 400)).filter(Boolean).slice(0, 10) };
}

// Already in the CRM? Checked by email, phone, website or name.
function matchExisting(l) {
  const ph = digits(l.phone);
  const host = l.website ? hostOf(l.website) : null;
  const contact = (l.email && db.one('SELECT id, first_name, last_name FROM contacts WHERE lower(email) = ?', l.email))
    || (ph && db.all('SELECT id, first_name, last_name, mobile, phone FROM contacts WHERE mobile IS NOT NULL OR phone IS NOT NULL').find((c) => [c.mobile, c.phone].some((x) => x && digits(x) === ph)));
  if (contact) return { kind: 'contact', id: contact.id, name: [contact.first_name, contact.last_name].filter(Boolean).join(' '), link: `#/contacts/${contact.id}` };
  const partners = db.all('SELECT id, name, company, email, phone, mobile, notes FROM referral_partners');
  const partner = partners.find((p) => (l.email && p.email && p.email.toLowerCase() === l.email)
    || (ph && [p.phone, p.mobile].some((x) => x && digits(x) === ph))
    || (host && p.notes && p.notes.includes(host))
    || (p.name.toLowerCase() === l.name.toLowerCase() && (!l.organisation || !p.company || p.company.toLowerCase() === l.organisation.toLowerCase())));
  if (partner) return { kind: 'partner', id: partner.id, name: partner.name, link: '#/partners' };
  return null;
}

// ---- Running a search -----------------------------------------------------------------------

async function search(s) {
  const client = ai.clientFor();
  const business = db.getSetting('business_name', '');
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 15, user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' } },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 15 },
    SAVE_TOOL,
  ];
  const ask = [
    `Find: ${s.request}`,
    s.lead_type !== 'any' ? `Type: ${LEAD_TYPES[s.lead_type]}` : null,
    s.location ? `Area: ${s.location}` : null,
    `Up to ${s.max_results} leads.`,
  ].filter(Boolean).join('\n');
  const messages = [{ role: 'user', content: ask }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  let model = ai.model();
  for (let turn = 0; turn < 8; turn += 1) {
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: ai.model(),
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: systemPrompt(s, business),
        tools,
        tool_choice: { type: 'auto' },
        messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      messages.push({ role: 'user', content: 'The list didn\'t come through complete. Please call save_leads again with all the leads.' });
      continue;
    }
    model = message.model || model;
    usage.input_tokens += message.usage?.input_tokens || 0;
    usage.output_tokens += message.usage?.output_tokens || 0;
    usage.web_searches += message.usage?.server_tool_use?.web_search_requests || 0;
    if (message.stop_reason === 'refusal') throw new HttpError(502, 'The AI service declined this search. Try rewording the request.');
    if (message.stop_reason === 'max_tokens') throw new HttpError(502, 'Too many results to save at once. Ask for fewer leads.');
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason === 'pause_turn') continue;
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === 'save_leads');
    if (!call) {
      messages.push({ role: 'user', content: 'Please call save_leads now with what you found (an empty list is fine if nothing matched).' });
      continue;
    }
    if (!call.input || !Array.isArray(call.input.leads)) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: JSON.stringify({ INVALID_JSON: 'leads must be a list' }) }] });
      continue;
    }
    return { ...clean(call.input), model, usage };
  }
  throw new HttpError(502, 'The search didn\'t finish. Try a narrower request.');
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service is busy. Try again in a few minutes.';
  if (err instanceof Anthropic.APIError) return `The AI service had a problem (${err.status ?? 'no response'}). Try again shortly.`;
  return err.message || String(err);
}

function start(userId, input = {}) {
  if (!ai.configured()) throw new HttpError(400, 'The lead generator needs an Anthropic API key. An admin can add one in Settings → AI.');
  const request = String(input.request || '').trim();
  if (request.length < 5) throw new HttpError(400, 'Describe the leads you\'re looking for');
  if (request.length > 1000) throw new HttpError(400, 'Keep the request under 1,000 characters');
  const leadType = Object.hasOwn(LEAD_TYPES, input.lead_type) ? input.lead_type : 'any';
  const max = Math.min(30, Math.max(5, Number(input.max_results) || 15));
  if (db.one("SELECT 1 FROM lead_searches WHERE user_id = ? AND status = 'searching' AND created_at > ?", userId, new Date(Date.now() - 15 * 60000).toISOString())) {
    throw new HttpError(400, 'You already have a search running. Wait for it to finish.');
  }
  const s = { request, lead_type: leadType, location: String(input.location || '').trim().slice(0, 120) || null, max_results: max };
  const id = db.insert('lead_searches', { user_id: userId, ...s });
  const done = (async () => {
    try {
      const r = await search(s);
      db.update('lead_searches', id, {
        status: 'ready', results: JSON.stringify(r.leads), notes: JSON.stringify(r.notes), model: r.model, usage: JSON.stringify(r.usage), completed_at: nowIso(),
      });
      db.insert('notifications', { user_id: userId, message: `Lead search finished: ${r.leads.length} lead${r.leads.length === 1 ? '' : 's'} for "${request.slice(0, 60)}"`, link: `#/leads/${id}` });
    } catch (err) {
      db.update('lead_searches', id, { status: 'failed', error: friendly(err), completed_at: nowIso() });
    }
  })();
  return { id, done };
}

// ---- Reading and acting on results ------------------------------------------------------------

function get(id, userId) {
  const r = db.one('SELECT * FROM lead_searches WHERE id = ? AND user_id = ?', id, userId);
  if (!r) throw new HttpError(404, 'Search not found');
  const leads = r.results ? JSON.parse(r.results) : [];
  return {
    id: r.id, request: r.request, lead_type: r.lead_type, lead_type_label: LEAD_TYPES[r.lead_type], location: r.location, max_results: r.max_results,
    status: r.status, error: r.error, created_at: r.created_at, completed_at: r.completed_at, usage: r.usage ? JSON.parse(r.usage) : null,
    notes: r.notes ? JSON.parse(r.notes) : [],
    leads: leads.map((l) => ({ ...l, category_label: CATEGORIES[l.category], existing: l.status === 'new' ? matchExisting(l) : null })),
  };
}

const list = (userId) => db.all('SELECT id, request, location, status, results, created_at FROM lead_searches WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId)
  .map((r) => {
    const leads = r.results ? JSON.parse(r.results) : [];
    return { id: r.id, request: r.request, location: r.location, status: r.status, created_at: r.created_at, count: leads.length, added: leads.filter((l) => l.status === 'added').length };
  });

function updateLead(id, userId, leadId, patch) {
  const r = db.one('SELECT * FROM lead_searches WHERE id = ? AND user_id = ?', id, userId);
  if (!r?.results) throw new HttpError(404, 'Search not found');
  const leads = JSON.parse(r.results);
  const l = leads.find((x) => x.id === Number(leadId));
  if (!l) throw new HttpError(404, 'Lead not found');
  Object.assign(l, patch);
  db.update('lead_searches', id, { results: JSON.stringify(leads) });
  return l;
}

const splitName = (name) => {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? { first_name: parts.slice(0, -1).join(' '), last_name: parts.at(-1) } : { first_name: parts[0], last_name: null };
};
const looksLikePerson = (l) => l.organisation && l.name !== l.organisation && /^[A-Z][a-z'’-]+(\s+[A-Z][a-z'’-]+){1,3}$/.test(l.name);
const sourceNote = (l, s) => [
  `Found by the lead generator on ${formatDate(today())} ("${s.request.slice(0, 120)}").`,
  l.relevance ? `Why: ${l.relevance}` : null,
  l.outreach_tip ? `Approach: ${l.outreach_tip}` : null,
  l.website ? `Website: ${l.website}` : null,
  `Source: ${l.source_url}`,
].filter(Boolean).join('\n');

// as: 'lead' (a contact) or 'partner' (a referral partner).
function add(id, userId, leadId, as) {
  const s = get(id, userId);
  const l = s.leads.find((x) => x.id === Number(leadId));
  if (!l) throw new HttpError(404, 'Lead not found');
  if (l.status === 'added') throw new HttpError(400, 'Already added');
  if (as === 'partner') {
    const partnerId = db.insert('referral_partners', {
      name: l.name, company: l.organisation && l.organisation !== l.name ? l.organisation : null,
      type: PARTNER_TYPES.includes(l.category) ? l.category : 'other', email: l.email, phone: l.phone, notes: sourceNote(l, s),
    });
    updateLead(id, userId, leadId, { status: 'added', added_as: 'partner', added_id: partnerId });
    return { added_as: 'partner', id: partnerId, link: '#/partners' };
  }
  const person = looksLikePerson(l) ? splitName(l.name) : { first_name: l.name, last_name: null };
  // No marketing consent: they haven't asked to hear from us.
  const contactId = db.insert('contacts', {
    ...person, email: l.email, phone: l.phone, suburb: l.suburb, state: l.state, employer: l.organisation,
    status: 'lead', lead_source: 'lead_generator', owner_id: userId, marketing_opt_in: 0, tags: 'lead-generator', background: sourceNote(l, s),
  });
  db.insert('activities', { contact_id: contactId, user_id: userId, type: 'system', body: `Added from a lead search: ${l.source_url}` });
  updateLead(id, userId, leadId, { status: 'added', added_as: 'lead', added_id: contactId });
  return { added_as: 'lead', id: contactId, link: `#/contacts/${contactId}` };
}

const dismiss = (id, userId, leadId, undo = false) => updateLead(id, userId, leadId, { status: undo ? 'new' : 'dismissed' });
const remove = (id, userId) => db.run('DELETE FROM lead_searches WHERE id = ? AND user_id = ?', id, userId).changes > 0;

module.exports = { CATEGORIES, LEAD_TYPES, LEAD_SCHEMA, start, search, clean, get, list, add, dismiss, remove, matchExisting };
