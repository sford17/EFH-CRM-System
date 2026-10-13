// AI assistant: ask questions about the CRM, or give it tasks. Lookups run
// straight away; anything that changes data or contacts someone is shown as
// a card to approve (emails and texts can be edited first).
import { api, h, toast, confirmDialog, dateTime } from '../core.js';

const SUGGESTIONS = [
  'Which clients have fixed rates ending in the next 90 days?',
  'What\'s due to settle this month, and is anything overdue?',
  'What tasks are overdue?',
  'How are settlements and commission tracking this financial year?',
  'Which leads haven\'t been contacted in the last 2 weeks?',
  'What\'s the stamp duty on an $850,000 home in NSW for a first home buyer?',
];

// Safe, small markdown: paragraphs, bullets, **bold**, `code`, tables and
// links to CRM pages (#/...) or https.
function inline(text) {
  const out = [];
  const re = /\[([^\]]+)\]\(((?:#\/|https:\/\/)[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('a', { href: m[2], ...(m[2].startsWith('https') ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, m[1]));
    else if (m[3]) out.push(h('strong', m[3]));
    else out.push(h('code', m[4]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function markdown(text) {
  const blocks = [];
  const lines = String(text).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i -= 1;
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      blocks.push(h('div.table-wrap', h('table', h('thead', h('tr', cells[0].map((c) => h('th', inline(c))))), h('tbody', cells.slice(1).map((r) => h('tr', r.map((c) => h('td', inline(c)))))))));
    } else if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+\.)\s+/, ''));
      i -= 1;
      blocks.push(h(ordered ? 'ol' : 'ul', items.map((t) => h('li', inline(t)))));
    } else if (/^#{1,4}\s+/.test(line)) {
      blocks.push(h('h4', inline(line.replace(/^#{1,4}\s+/, ''))));
    } else {
      blocks.push(h('p', inline(line)));
    }
  }
  return blocks;
}

function actionCard(a, { pending = false, choices = null } = {}) {
  const status = { done: ['✓ Done', 'ok'], declined: ['Declined', ''], failed: ['Didn\'t work', 'danger'], waiting: ['Waiting for you', 'warn'] }[a.outcome] || ['', ''];
  let editor = null;
  if (pending && a.preview != null) {
    editor = h('textarea.ai-preview-edit', { rows: Math.min(12, String(a.preview).split('\n').length + 2), 'aria-label': 'Message to send' }, a.preview);
  }
  const card = h(`div.ai-action${pending ? '.pending' : ''}.${a.outcome || 'waiting'}`,
    h('div.ai-action-head', h('span.ai-action-icon', pending ? '⚡' : a.outcome === 'done' ? '✓' : '•'), h('strong', a.summary),
      !pending ? h(`span.badge.${status[1]}`, status[0]) : null),
    editor || (a.preview ? h('pre.ai-preview', a.preview) : null),
    a.detail && typeof a.detail === 'string' ? h('div.small.text-danger', a.detail) : null,
    a.detail?.link ? h('div.small', h('a', { href: a.detail.link }, 'Open'), a.detail.status ? h('span.muted', ` · ${a.detail.status}`) : null) : null);
  if (pending && choices) {
    const approve = h('button.small', { type: 'button' }, 'Approve');
    const decline = h('button.small.secondary', { type: 'button' }, 'Decline');
    const mark = (v) => { choices.set(a.id, { choice: v, edit: editor ? editor.value : null }); approve.classList.toggle('chosen', v === 'approve'); decline.classList.toggle('chosen', v === 'decline'); card.dataset.choice = v; };
    approve.addEventListener('click', () => mark('approve'));
    decline.addEventListener('click', () => mark('decline'));
    editor?.addEventListener('input', () => { const c = choices.get(a.id); if (c) c.edit = editor.value; });
    card.append(h('div.ai-action-buttons', approve, decline));
  }
  return card;
}

let current = null; // conversation id being shown

export async function assistantPage(id) {
  const list = await api('/agent/conversations');
  if (!list.configured) {
    return h('div', h('div.page-header', h('h1', 'Assistant')),
      h('section.card', h('h2', 'Set up the assistant'), h('p', 'The assistant uses Claude. An admin needs to add an Anthropic API key in Settings → AI document reading & settlement letters.')));
  }
  current = id ? Number(id) : null;
  const convo = current ? await api(`/agent/conversations/${current}`).catch(() => null) : null;
  if (current && !convo) { location.hash = '#/assistant'; return h('div'); }

  const thread = h('div.ai-thread', { 'aria-live': 'polite' });
  const input = h('textarea.ai-input', { rows: 2, placeholder: 'Ask a question or give the assistant a task…', 'aria-label': 'Message' });
  const sendBtn = h('button', { type: 'submit' }, 'Send');
  const form = h('form.ai-compose', input, sendBtn);

  const scroll = () => { thread.scrollTop = thread.scrollHeight; };
  let state = convo;

  function render(c, { streaming = null } = {}) {
    thread.replaceChildren();
    if (!c || !c.items.length) {
      thread.append(h('div.ai-empty',
        h('h2', 'How can I help?'),
        h('p.muted', 'Ask about your clients, deals, loans, tasks and reports, or ask me to do things: create tasks, add notes, update deals, or email and text clients. I\'ll ask you to approve anything that changes the CRM or contacts someone.'),
        h('div.ai-suggestions', SUGGESTIONS.map((s) => h('button.secondary.small', { type: 'button', onclick: () => { input.value = s; submit(); } }, s)))));
    }
    const choices = new Map();
    const waiting = c?.waiting ? c.items.filter((i) => i.type === 'action' && i.outcome === 'waiting') : [];
    for (const item of c?.items || []) {
      if (item.type === 'user') thread.append(h('div.ai-msg.user', h('div.ai-bubble', item.text)));
      else if (item.type === 'assistant') thread.append(h('div.ai-msg.assistant', h('div.ai-bubble', markdown(item.text))));
      else if (item.type === 'lookup') thread.append(h('div.ai-lookup', '🔎 ', item.label));
      else if (item.type === 'action') thread.append(actionCard(item, { pending: item.outcome === 'waiting' && c.waiting, choices }));
    }
    if (waiting.length) {
      const go = h('button', { type: 'button' }, waiting.length > 1 ? 'Confirm my choices' : 'Confirm');
      const all = h('button.secondary.small', { type: 'button' }, 'Approve all');
      all.addEventListener('click', () => thread.querySelectorAll('.ai-action.pending .ai-action-buttons button:first-child').forEach((b) => b.click()));
      go.addEventListener('click', async () => {
        const decisions = {};
        const edits = {};
        for (const a of waiting) {
          const ch = choices.get(a.id);
          if (!ch) { toast('Approve or decline each action first', 'error'); return; }
          decisions[a.id] = ch.choice;
          if (ch.edit != null && ch.edit !== a.preview) edits[a.id] = a.name === 'send_sms' ? { message: ch.edit } : { body: ch.edit };
        }
        await stream(`/agent/conversations/${c.id}/decide`, { decisions, edits });
      });
      thread.append(h('div.ai-approve-bar', h('span.small', 'The assistant wants to do the above. Nothing happens until you confirm.'), waiting.length > 1 ? all : null, go));
    }
    if (streaming) thread.append(streaming);
    input.disabled = Boolean(c?.waiting);
    sendBtn.disabled = Boolean(c?.waiting);
    input.placeholder = c?.waiting ? 'Approve or decline the actions above first' : 'Ask a question or give the assistant a task…';
    scroll();
  }

  // Sends a request and shows the reply as it streams in.
  async function stream(path, body) {
    input.disabled = true;
    sendBtn.disabled = true;
    const live = h('div.ai-live');
    const bubble = h('div.ai-bubble', h('span.ai-typing', 'Thinking…'));
    let text = '';
    live.append(h('div.ai-msg.assistant', bubble));
    if (body.text) state = { ...(state || { id: current, items: [] }), items: [...(state?.items || []), { type: 'user', text: body.text }], waiting: false };
    render(state, { streaming: live });
    let res;
    try {
      res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    } catch {
      toast('Couldn\'t reach the CRM', 'error');
      render(state);
      return;
    }
    if (!(res.headers.get('content-type') || '').includes('event-stream')) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'Something went wrong', 'error');
      if (body.text) { state.items.pop(); input.value = body.text; }
      render(state);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        const e = JSON.parse(part.slice(6));
        if (e.type === 'text') { text += e.delta; bubble.replaceChildren(...markdown(text)); scroll(); }
        else if (e.type === 'reset') { text = ''; }
        else if (e.type === 'lookup') { live.insertBefore(h('div.ai-lookup', '🔎 ', e.label), live.lastChild); text = ''; bubble.replaceChildren(h('span.ai-typing', 'Working…')); scroll(); }
        else if (e.type === 'error') toast(e.message, 'error');
        else if (e.type === 'done') state = e.conversation;
      }
    }
    render(state);
    input.disabled = Boolean(state?.waiting);
    sendBtn.disabled = Boolean(state?.waiting);
    if (!state?.waiting) input.focus();
    // Refresh the list of conversations (titles) without leaving the page.
    api('/agent/conversations').then((l) => sidebar.replaceChildren(...convoList(l.rows))).catch(() => {});
  }

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    if (!current) {
      const c = await api('/agent/conversations', { method: 'POST', body: {} });
      current = c.id;
      state = c;
      history.replaceState(null, '', `#/assistant/${c.id}`);
    }
    input.value = '';
    await stream(`/agent/conversations/${current}/messages`, { text });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  const convoList = (rows) => [
    h('a.button.small.ai-new', { href: '#/assistant' }, '+ New conversation'),
    ...rows.map((r) => h(`a.ai-convo${r.id === current ? '.active' : ''}`, { href: `#/assistant/${r.id}` },
      h('span', r.title), h('span.small.muted', r.waiting ? '⚡ waiting for you' : dateTime(r.updated_at)))),
  ];
  const sidebar = h('nav.ai-convos', { 'aria-label': 'Conversations' }, convoList(list.rows));
  const del = current ? h('button.link.small', { type: 'button', onclick: async () => {
    if (!(await confirmDialog('Delete this conversation?'))) return;
    await api(`/agent/conversations/${current}`, { method: 'DELETE' });
    location.hash = '#/assistant';
  } }, 'Delete conversation') : null;

  render(state);
  setTimeout(() => input.focus(), 50);
  return h('div.ai-page',
    h('div.page-header', h('h1', 'Assistant'), h('div.actions', del)),
    h('div.ai-layout', sidebar,
      h('section.card.ai-chat', thread, form,
        h('p.small.muted.ai-note', 'Answers come from your CRM data and are sent to Anthropic (Claude) to be processed. Check important details before relying on them.'))));
}
