'use strict';
// The CRM's AI assistant: a conversation with Claude that can look things up
// in the CRM (read tools run straight away) and do things (action tools wait
// for the broker to approve them). Replies stream to the browser as they're
// written.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const ai = require('./loanDocsAI');
const tools = require('./agentTools');
const { today, nowIso, formatDate, HttpError } = require('../util');

const MAX_STEPS = 12; // model calls per message, so a runaway loop can't run up costs
const MAX_MESSAGES = 300;
const MAX_RESULT_CHARS = 30000;

function systemPrompt(user) {
  const business = db.getSetting('business_name', '') || 'an Australian mortgage broking business';
  return `You are the AI assistant built into the CRM of ${business}, an Australian mortgage broking business. You're helping ${user.name} (${user.role}). Today is ${formatDate(today())} (${today()}).

How to work:
- Look things up with the tools rather than guessing. Client details, loans, rates and dates must come from the CRM.
- When you mention a client, deal or task, link to it using the "link" value the tools return, as a markdown link, e.g. [Mia Jones](#/contacts/12).
- To change anything or contact someone, call the action tool (create_task, add_note, create_contact, update_deal, send_email, send_sms). The user sees an Approve button for each one, so don't ask "shall I?" first; just call it with everything filled in. If an action is declined, accept that and don't retry it unless asked.
- Emails and texts go to clients in ${user.name.split(' ')[0]}'s name: write them warmly and professionally in Australian English. Don't add a signature to emails (it's added automatically). Don't give personal credit advice or recommend specific products in client messages; offer to talk instead.
- Don't send marketing to contacts who have opted out (marketing_opt_in false).
- You can search the web for current news or rates when asked; say where information came from.
- Keep answers short and practical: lead with the answer, use bullet points or short tables for lists, and give totals where useful.`;
}

// ---- Conversations ---------------------------------------------------------------------------

function load(id, userId) {
  const c = db.one('SELECT * FROM ai_conversations WHERE id = ? AND user_id = ?', id, userId);
  if (!c) throw new HttpError(404, 'Conversation not found');
  return { ...c, messages: JSON.parse(c.messages), pending: c.pending ? JSON.parse(c.pending) : null, usage: c.usage ? JSON.parse(c.usage) : null };
}

function save(c) {
  db.update('ai_conversations', c.id, {
    title: c.title, messages: JSON.stringify(c.messages), pending: c.pending ? JSON.stringify(c.pending) : null,
    usage: c.usage ? JSON.stringify(c.usage) : null, updated_at: nowIso(),
  });
}

const list = (userId) => db.all('SELECT id, title, updated_at, pending IS NOT NULL AS waiting FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', userId)
  .map((c) => ({ ...c, waiting: Boolean(c.waiting) }));
const create = (userId) => db.insert('ai_conversations', { user_id: userId });
const remove = (id, userId) => db.run('DELETE FROM ai_conversations WHERE id = ? AND user_id = ?', id, userId).changes > 0;

// What the browser shows: the user's messages, the assistant's text, a line
// for each lookup, and each action with its outcome.
function display(c) {
  const items = [];
  const results = new Map();
  for (const m of c.messages) {
    if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  }
  for (const m of c.messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') items.push({ type: 'user', text: m.content });
      else for (const b of m.content) if (b.type === 'text') items.push({ type: 'user', text: b.text });
      continue;
    }
    for (const b of m.content || []) {
      if (b.type === 'text' && b.text.trim()) items.push({ type: 'assistant', text: b.text });
      else if (b.type === 'server_tool_use' && b.name === 'web_search') items.push({ type: 'lookup', label: `Searched the web for "${b.input?.query || ''}"` });
      else if (b.type === 'tool_use' && tools.isRead(b.name)) items.push({ type: 'lookup', label: tools.label(b.name, b.input) });
      else if (b.type === 'tool_use' && tools.isAction(b.name)) {
        const r = results.get(b.id);
        let outcome = 'waiting';
        let detail = null;
        if (r) {
          const text = typeof r.content === 'string' ? r.content : (r.content || []).map((x) => x.text).join('');
          outcome = r.is_error ? (/declined/i.test(text) ? 'declined' : 'failed') : 'done';
          detail = r.is_error ? text.replace(/^\{"error":"|"\}$/g, '') : null;
          try { const j = JSON.parse(text); detail = r.is_error ? (j.error || detail) : (j.link ? { link: j.link, status: j.status } : null); } catch { /* plain text */ }
        }
        let summary = b.name;
        try { summary = tools.ACTIONS[b.name].summary(b.input); } catch { /* record since removed */ }
        let preview = tools.ACTIONS[b.name].preview ? tools.ACTIONS[b.name].preview(b.input) : null;
        try {
          const sent = r && !r.is_error ? JSON.parse(r.content).sent_text : null;
          if (sent) preview = sent; // what was actually sent, after the broker's edits
        } catch { /* not JSON */ }
        items.push({ type: 'action', id: b.id, name: b.name, summary, preview, outcome, detail });
      }
    }
  }
  return { id: c.id, title: c.title, items, waiting: Boolean(c.pending), usage: c.usage };
}

// ---- Talking to Claude ---------------------------------------------------------------------------

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service is busy right now. Try again in a minute.';
  if (err instanceof Anthropic.APIError) return `The AI service had a problem (${err.status ?? 'no response'}). Try again shortly.`;
  return err.message || String(err);
}

const clipResult = (value) => {
  const text = JSON.stringify(value);
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (cut short: ask for fewer results)` : text;
};

async function runTool(block, ctx) {
  const t = tools.tool(block.name);
  if (!t) return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ error: `There's no tool called ${block.name}` }) };
  const problem = tools.check(t.input_schema, block.input);
  if (problem) return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ INVALID_JSON: problem }) };
  try {
    return { type: 'tool_result', tool_use_id: block.id, content: clipResult(await t.run(block.input, ctx)) };
  } catch (err) {
    return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ error: err.message }) };
  }
}

// Runs the model until it answers, or stops to ask for approval.
async function loop(c, user, emit) {
  const client = ai.clientFor('assistant', { userId: user.id });
  const ctx = { user };
  const defs = [...tools.definitions(), { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'AU', timezone: 'Australia/Sydney' } }];
  c.usage = c.usage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let parseRetries = 0;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    let message;
    try {
      const stream = client.beta.messages.stream({
        model: ai.model(),
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: systemPrompt(user),
        tools: defs,
        tool_choice: { type: 'auto' },
        messages: c.messages,
      });
      stream.on('text', (delta) => emit({ type: 'text', delta }));
      message = await stream.finalMessage();
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) && parseRetries < 1) {
        parseRetries += 1; // a tool call that couldn't be read: ask again
        emit({ type: 'reset' });
        continue;
      }
      throw err;
    }
    c.usage.input_tokens += message.usage?.input_tokens || 0;
    c.usage.output_tokens += message.usage?.output_tokens || 0;
    c.usage.cache_read_input_tokens += message.usage?.cache_read_input_tokens || 0;
    c.messages.push({ role: 'assistant', content: message.content });
    save(c);
    if (message.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'The assistant can\'t help with that request.' });
      return;
    }
    if (message.stop_reason === 'pause_turn') continue; // web searching: carry on
    const calls = message.content.filter((b) => b.type === 'tool_use');
    if (!calls.length) {
      if (message.stop_reason === 'max_tokens') emit({ type: 'error', message: 'The answer was cut short. Ask for a shorter answer, or break the question up.' });
      return;
    }
    if (message.stop_reason === 'max_tokens') {
      // A tool call cut off part-way: don't run it.
      c.messages.push({ role: 'user', content: calls.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: JSON.stringify({ error: 'Your reply was cut off. Try again with less.' }) })) });
      continue;
    }
    const results = [];
    const actions = [];
    for (const b of calls) {
      if (tools.isAction(b.name)) {
        const problem = tools.check(tools.ACTIONS[b.name].input_schema, b.input);
        if (problem) {
          results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: JSON.stringify({ INVALID_JSON: problem }) });
          continue;
        }
        let summary = b.name;
        try { summary = tools.ACTIONS[b.name].summary(b.input); } catch { /* shown by name */ }
        actions.push({ id: b.id, name: b.name, input: b.input, summary, preview: tools.ACTIONS[b.name].preview ? tools.ACTIONS[b.name].preview(b.input) : null });
      } else {
        emit({ type: 'lookup', label: tools.label(b.name, b.input) });
        results.push(await runTool(b, ctx));
      }
    }
    if (actions.length) {
      c.pending = { results, actions, order: calls.map((b) => b.id) };
      save(c);
      emit({ type: 'approval', actions: actions.map(({ input, ...a }) => a) });
      return;
    }
    c.messages.push({ role: 'user', content: results });
    save(c);
  }
  emit({ type: 'error', message: 'That took more steps than allowed. Try a narrower question.' });
}

async function send(id, user, text, emit) {
  if (!ai.configured()) throw new HttpError(400, 'The assistant needs an Anthropic API key. An admin can add one in Settings → AI.');
  const c = load(id, user.id);
  if (c.pending) throw new HttpError(400, 'Approve or decline the actions above first');
  const t = String(text || '').trim();
  if (!t) throw new HttpError(400, 'Type a question or a task');
  if (c.messages.length >= MAX_MESSAGES) throw new HttpError(400, 'This conversation is very long. Start a new one.');
  c.messages.push({ role: 'user', content: t.slice(0, 20000) });
  if (c.title === 'New conversation') c.title = t.replace(/\s+/g, ' ').slice(0, 70);
  save(c);
  try {
    await loop(c, user, emit);
  } catch (err) {
    emit({ type: 'error', message: friendly(err) });
  }
  return display(load(id, user.id));
}

// decisions: { [tool_use_id]: 'approve' | 'decline' }, plus optional edits
// to an email/text before it's sent: { [tool_use_id]: { body | message } }.
async function decide(id, user, decisions = {}, edits = {}, emit) {
  const c = load(id, user.id);
  if (!c.pending) throw new HttpError(400, 'There\'s nothing waiting for approval');
  const ctx = { user };
  const byId = new Map(c.pending.results.map((r) => [r.tool_use_id, r]));
  for (const a of c.pending.actions) {
    const choice = Object.hasOwn(decisions, a.id) ? decisions[a.id] : 'decline';
    if (choice !== 'approve') {
      byId.set(a.id, { type: 'tool_result', tool_use_id: a.id, is_error: true, content: JSON.stringify({ error: 'The user declined this action.' }) });
      continue;
    }
    const input = { ...a.input };
    const edit = Object.hasOwn(edits, a.id) ? edits[a.id] : null;
    if (edit && a.name === 'send_email' && typeof edit.body === 'string' && edit.body.trim()) input.body = edit.body;
    if (edit && a.name === 'send_sms' && typeof edit.message === 'string' && edit.message.trim()) input.message = edit.message;
    emit({ type: 'lookup', label: `Doing it: ${a.summary}` });
    const result = await runTool({ id: a.id, name: a.name, input }, ctx);
    if (edit && !result.is_error) {
      result.content = JSON.stringify({ ...JSON.parse(result.content), note: 'The user edited the wording before it was sent.', sent_text: input.body ?? input.message });
    }
    byId.set(a.id, result);
  }
  c.messages.push({ role: 'user', content: c.pending.order.map((tid) => byId.get(tid)).filter(Boolean) });
  c.pending = null;
  save(c);
  try {
    await loop(c, user, emit);
  } catch (err) {
    emit({ type: 'error', message: friendly(err) });
  }
  return display(load(id, user.id));
}

module.exports = { list, create, remove, load, display, send, decide, systemPrompt };
