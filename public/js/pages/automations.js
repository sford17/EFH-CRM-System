import { api, h, pageHeader, table, badge, dateTime, attempt, confirmDialog, label, toast, state, opts, userOptions, modal, stageLabel } from '../core.js';
import { CONTACT_STATUSES } from './forms.js';
import { counted } from './sms.js';

// Conditions in plain English.
const FIELD_LABELS = {
  'event.to_stage': 'New deal stage', 'event.from_stage': 'Previous deal stage', 'event.to_status': 'New contact status',
  'contact.status': 'Contact status', 'contact.lead_source': 'Lead source', 'contact.tags': 'Contact tags',
  'contact.employment_type': 'Employment type', 'contact.state': 'State', 'contact.marketing_opt_in': 'Happy to receive marketing (1 = yes)',
  'contact.annual_income': 'Annual income', 'contact.google_reviewed_at': 'Google review left (date)', 'contact.review_requested_at': 'Google review last asked (date)',
  'deal.stage': 'Deal stage', 'deal.loan_purpose': 'Loan purpose', 'deal.loan_amount': 'Loan amount', 'deal.lvr': 'LVR (%)',
  'deal.lender_name': 'Lender', 'deal.rate_type': 'Rate type', 'deal.priority': 'Deal priority', 'deal.referral_partner_id': 'Referral partner (ID)', 'task.title': 'Task title',
};
const STAGE_FIELDS = ['event.to_stage', 'event.from_stage', 'deal.stage'];
const STATUS_FIELDS = ['event.to_status', 'contact.status'];
const OP_LABELS = {
  eq: 'is', neq: 'is not', in: 'is one of', not_in: 'is not one of', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  contains: 'contains', has_tag: 'has the tag', empty: 'is empty', not_empty: 'is filled in',
};
const NO_VALUE = ['empty', 'not_empty'];

// Each kind of step: label, icon, colour group and a one-line explanation for the picker.
const ACTIONS = {
  send_email: { label: 'Send an email', icon: '✉', group: 'talk', hint: 'One of your email templates, to the client, agent, solicitor or broker' },
  send_sms: { label: 'Send an SMS', icon: '💬', group: 'talk', hint: 'A text from the broker\'s mobile to the client or referral partner' },
  email_broker: { label: 'Email me (the broker) a reminder', icon: '📨', group: 'talk', hint: 'A reminder to you, with a client snapshot if you like' },
  send_fact_find: { label: 'Send the online fact find', icon: '☑', group: 'talk', hint: 'The online fact find, or a request for documents only' },
  create_task: { label: 'Create a task', icon: '✓', group: 'task', hint: 'A to-do for the broker or someone else, due in so many days' },
  add_note: { label: 'Add a note to the timeline', icon: '📝', group: 'task', hint: 'A note on the client\'s timeline' },
  notify: { label: 'Notify the owner', icon: '🔔', group: 'task', hint: 'A notification in the CRM for the record\'s owner' },
  set_deal_stage: { label: 'Move deal to stage', icon: '➜', group: 'update', hint: 'Move the deal along the pipeline' },
  set_contact_status: { label: 'Set contact status', icon: '👤', group: 'update', hint: 'e.g. lead → client' },
  add_tag: { label: 'Add a tag', icon: '🏷', group: 'update', hint: 'Tag the contact, e.g. "first home buyer"' },
  remove_tag: { label: 'Remove a tag', icon: '🏷', group: 'update', hint: 'Take a tag off the contact' },
  create_document_checklist: { label: 'Add standard document checklist', icon: '📋', group: 'admin', hint: 'The standard list of documents on the deal' },
  generate_commissions: { label: 'Generate commission entries', icon: '$', group: 'admin', hint: 'Upfront and trail entries from the lender\'s rates' },
};
const GROUPS = { talk: 'Talk to people', task: 'Tasks and notes', update: 'Update the record', admin: 'Deal admin' };
const actionLabel = (type) => ACTIONS[type]?.label || label(type);

// Ready-made steps for the picker: one click adds a filled-in step to adjust.
const SUGGESTIONS = [
  { title: 'Call the client tomorrow', icon: '📞', action: { type: 'create_task', title: 'Call {{contact.full_name}}', due_in_days: 1, priority: 'normal', assign_to: 'owner' } },
  { title: 'Text the client an update', icon: '💬', action: { type: 'send_sms', message: 'Hi {{contact.first_name}}, just a quick update on your loan: ' } },
  { title: 'Email the client a template', icon: '✉', action: { type: 'send_email', to: 'contact' } },
  { title: 'Remind me in 3 days', icon: '📨', action: { type: 'email_broker', user: 'owner', subject: 'Reminder: {{contact.full_name}}', message: 'Time to follow up with {{contact.full_name}}.', details: 'none', delay_days: 3 } },
  { title: 'Send the online fact find', icon: '☑', action: { type: 'send_fact_find', kind: 'full' } },
  { title: 'Ask for documents', icon: '📎', action: { type: 'send_fact_find', kind: 'documents', documents: 'Last 2 payslips\nLast 3 months of bank statements' } },
  { title: 'Follow-up task next week', icon: '✓', action: { type: 'create_task', title: 'Follow up {{contact.full_name}}', due_in_days: 7, priority: 'normal', assign_to: 'owner' } },
  { title: 'Make them a client', icon: '👤', action: { type: 'set_contact_status', status: 'client' } },
];

let meta;
let templates;
async function loadMeta() {
  [meta, templates] = await Promise.all([api('/automations/meta'), api('/templates').then((r) => r.rows)]);
}
const cleanTrigger = (text) => String(text).replace(/\s*\((days_before|days_inactive)\)/, '');
const triggerLabel = (key) => cleanTrigger([...meta.event_triggers, ...meta.scheduled_triggers].find((t) => t.key === key)?.label || key);
const templateName = (id) => templates.find((t) => t.id === Number(id))?.name;

// A short description of a step for the diagram and the list.
function describe(x) {
  const after = x.delay_days ? ` after ${x.delay_days} day${Number(x.delay_days) === 1 ? '' : 's'}` : '';
  switch (x.type) {
    case 'send_email': {
      const to = { main_contact: 'the main client', broker: 'the broker' }[x.to] || state.meta.party_roles.find((r) => r.key === x.to)?.label.toLowerCase() || 'the client';
      return `"${templateName(x.template_id) || 'choose a template'}" to ${to}${after}`;
    }
    case 'send_sms': return `${x.to === 'referral_partner' ? 'To the referral partner' : 'To the client'}${x.marketing ? ' (marketing)' : ''}${after}: "${String(x.message || '').slice(0, 70)}${String(x.message || '').length > 70 ? '…' : ''}"`;
    case 'email_broker': return `${x.subject ? `"${x.subject}"` : 'Standard reminder'}${after}`;
    case 'send_fact_find': return x.kind === 'documents' ? 'Request documents only' : 'Online fact find with documents';
    case 'create_task': return `"${x.title || 'untitled'}"${x.due_in_days ? `, due in ${x.due_in_days} day${Number(x.due_in_days) === 1 ? '' : 's'}` : ', due today'}`;
    case 'add_note': return x.body ? `"${x.body}"` : '';
    case 'notify': return x.message ? `"${x.message}"` : '';
    case 'set_deal_stage': return x.stage ? stageLabel(x.stage) : '';
    case 'set_contact_status': return x.status ? label(x.status) : '';
    case 'add_tag': case 'remove_tag': return x.tag ? `"${x.tag}"` : '';
    default: return '';
  }
}

// What's missing before the step can work.
function problem(x) {
  if (x.type === 'send_email' && !templateName(x.template_id)) return 'Choose a template';
  if (x.type === 'send_sms' && !String(x.message || '').trim()) return 'Write the message';
  if (x.type === 'create_task' && !String(x.title || '').trim()) return 'Give the task a title';
  if (['add_tag', 'remove_tag'].includes(x.type) && !x.tag) return 'Enter the tag';
  if (x.type === 'set_deal_stage' && !x.stage) return 'Choose the stage';
  if (x.type === 'set_contact_status' && !x.status) return 'Choose the status';
  if (x.type === 'add_note' && !x.body) return 'Write the note';
  if (x.type === 'notify' && !x.message) return 'Write the message';
  return null;
}

function conditionText(c) {
  const field = FIELD_LABELS[c.field] || c.field;
  if (NO_VALUE.includes(c.op)) return `${field} ${OP_LABELS[c.op]}`;
  const values = String(c.value ?? '').split(',').map((v) => v.trim()).filter(Boolean)
    .map((v) => (STAGE_FIELDS.includes(c.field) ? stageLabel(v) : STATUS_FIELDS.includes(c.field) ? label(v) : v));
  return `${field} ${OP_LABELS[c.op] || c.op} ${values.join(c.op === 'in' || c.op === 'not_in' ? ' or ' : ', ') || '…'}`;
}

function triggerDetail(trigger, config) {
  if (config.days_before !== undefined && /_expiry|finance_due|settlement_upcoming|appointment_upcoming|annual_review/.test(trigger)) return `${config.days_before} days before`;
  if (config.days_inactive !== undefined && /stale_/.test(trigger)) return `after ${config.days_inactive} days without activity`;
  return trigger.startsWith('schedule.') ? 'Checked every few minutes' : 'Runs straight away';
}

// ---- List ---------------------------------------------------------------------

// The automation as a row of little boxes: ⚡ When → step → step.
function miniFlow(a) {
  const chips = [h('span.flow-chip.when', '⚡ ', triggerLabel(a.trigger))];
  if (a.conditions.length) chips.push(h('span.flow-chip.cond', { title: a.conditions.map(conditionText).join('\n') }, `if ${a.conditions.length} condition${a.conditions.length === 1 ? '' : 's'}`));
  for (const x of a.actions) {
    chips.push(h(`span.flow-chip.g-${ACTIONS[x.type]?.group || 'admin'}`, { title: describe(x) }, `${ACTIONS[x.type]?.icon || '•'} ${actionLabel(x.type)}${x.delay_days ? ` (+${x.delay_days}d)` : ''}`));
  }
  return h('div.flow-mini', chips.flatMap((c, i) => (i ? [h('span.flow-arrow', { 'aria-hidden': 'true' }, '→'), c] : [c])));
}

export async function automationsPage() {
  await loadMeta();
  const [{ rows }, runs] = await Promise.all([api('/automations'), api('/automations/runs?limit=50')]);
  const runNow = async () => {
    const r = await attempt(() => api('/automations/run-scheduled', { method: 'POST', body: {} }));
    toast(r.results.length ? `${r.results.length} scheduled automation run(s)` : 'Nothing due right now');
    window.dispatchEvent(new Event('crm:refresh'));
  };
  const toggle = async (a, enabled) => {
    await attempt(() => api(`/automations/${a.id}`, { method: 'PATCH', body: { enabled: enabled ? 1 : 0 } }), enabled ? 'Enabled' : 'Paused');
  };
  const group = (title, filter) => {
    const list = rows.filter(filter);
    return h('section.card', h('h2', title), table([
      { label: 'On', value: (a) => h('label.switch', h('input', { type: 'checkbox', checked: !!a.enabled, 'aria-label': `Enable ${a.name}`, onchange: (e) => toggle(a, e.target.checked) }), h('span')) },
      { label: 'Automation', value: (a) => h('div', h('a', { href: `#/automations/${a.id}` }, a.name), miniFlow(a)) },
      { label: 'Runs', value: (a) => String(a.run_count), class: 'num' },
      { label: 'Last run', value: (a) => dateTime(a.last_run_at) },
    ], list, { empty: 'None.', onRow: (a) => { location.hash = `#/automations/${a.id}`; } }));
  };
  return h('div',
    pageHeader('Automations',
      h('button.secondary', { type: 'button', onclick: runNow }, 'Run scheduled checks now'),
      h('a.button', { href: '#/automations/new' }, '+ New automation')),
    h('p.muted', 'Event automations run instantly when something happens. Scheduled automations are checked every few minutes by the background scheduler and only fire once per record and date. Click one to see and change its steps.'),
    group('Event automations', (a) => !a.trigger.startsWith('schedule.')),
    group('Scheduled automations', (a) => a.trigger.startsWith('schedule.')),
    h('section.card', h('h2', 'Recent runs'), table([
      { label: 'When', value: (r) => dateTime(r.created_at) },
      { label: 'Automation', value: (r) => h('a', { href: `#/automations/${r.automation_id}` }, r.automation_name) },
      { label: 'Record', value: (r) => (r.entity_id ? h('a', { href: `#/${r.entity_type}s/${r.entity_id}` }, `${label(r.entity_type)} #${r.entity_id}`) : '—') },
      { label: 'Result', value: (r) => h('div', badge(r.status, r.status === 'success' ? 'ok' : 'danger'), h('pre.small', r.detail)) },
    ], runs.rows, { empty: 'No runs yet.' })));
}

// ---- Editor: the automation as a diagram -----------------------------------------------------------

function actionFieldDefs(type) {
  const templateOpts = [['', 'Choose a template…'], ...templates.map((t) => [t.id, t.name])];
  switch (type) {
    case 'create_task': return [
      ['title', 'Task title (merge fields allowed, e.g. {{contact.full_name}})', 'text'],
      ['due_in_days', 'Due in (days)', 'number'],
      ['priority', 'Priority', 'select', opts(['low', 'normal', 'high'])],
      ['assign_to', 'Assign to', 'select', [['owner', 'Record owner'], ...userOptions()]],
      ['description', 'Details', 'text'],
    ];
    case 'send_email': return [
      ['template_id', 'Template', 'select', templateOpts],
      ['to', 'Send to', 'select', [['contact', 'Client (both borrowers on joint loans)'], ['main_contact', 'Main client only'], ...state.meta.party_roles.map((r) => [r.key, `The deal's ${r.label.toLowerCase()}`]), ['broker', 'Broker (internal)']]],
      ['delay_days', 'Wait before sending (days)', 'number'],
    ];
    case 'send_sms': return [
      ['to', 'Send to', 'select', [['', 'Client'], ['referral_partner', 'Referral partner who referred the client']]],
      ['message', 'Text message (merge fields allowed, e.g. {{contact.first_name}}, {{broker.first_name}}, {{referrer.first_name}})', 'textarea'],
      ['delay_days', 'Wait before sending (days)', 'number'],
      ['marketing', 'Type', 'select', [['', 'Service update (always sent)'], ['true', 'Marketing (needs consent, adds opt-out)']]],
    ];
    case 'email_broker': return [
      ['user', 'Email', 'select', [['owner', 'The client\'s broker (record owner)'], ...userOptions()]],
      ['subject', 'Subject (blank for the standard annual review wording)', 'text'],
      ['message', 'Message (blank for the standard wording; merge fields allowed, e.g. {{contact.full_name}}, {{event.review_date|date}}, {{event.when}})', 'textarea'],
      ['details', 'Include', 'select', [['', 'Client snapshot, position summary, lending structure and a link'], ['none', 'Just the message and a link']]],
      ['delay_days', 'Wait before sending (days)', 'number'],
    ];
    case 'send_fact_find': return [
      ['kind', 'Send', 'select', [['full', 'Online fact find (with documents)'], ['documents', 'Request documents only']]],
      ['documents', 'Documents to request, one per line (for "Request documents only")', 'textarea'],
      ['message', 'Message (blank for the standard wording; merge fields allowed)', 'textarea'],
      ['expires_days', 'Link works for (days, default 30)', 'number'],
    ];
    case 'add_note': return [['body', 'Note', 'text']];
    case 'add_tag': case 'remove_tag': return [['tag', 'Tag', 'text']];
    case 'set_contact_status': return [['status', 'Status', 'select', [['', 'Choose…'], ...opts(CONTACT_STATUSES)]]];
    case 'set_deal_stage': return [['stage', 'Stage', 'select', [['', 'Choose…'], ...state.meta.stages.map((s) => [s.key, s.label])]]];
    case 'notify': return [['message', 'Message', 'text']];
    default: return [];
  }
}

const MERGE_HELP = 'Merge fields: {{contact.first_name}}, {{contact.full_name}}, {{deal.title}}, {{deal.loan_amount|money}}, {{deal.settlement_date|date}}, {{deal.lender_name}}, {{deal.stage_label}}, {{broker.name}}, {{broker.booking_link}}, {{agent.name}}, {{agent.company}}, {{solicitor.name}}, {{buyers_agent.name}}, {{referrer.first_name}} / {{referrer.name}} (the referral partner), and {{recipient.first_name}} for emails sent to the agent or solicitor. For appointment triggers: {{event.title}}, {{event.when}}, {{event.location}}, {{event.join_url}}';

export async function automationPage(id) {
  await loadMeta();
  const isNew = id === 'new';
  const a = isNew
    ? { name: '', description: '', trigger: 'deal.stage_changed', trigger_config: {}, conditions: [], actions: [], enabled: 1, runs: [] }
    : await api(`/automations/${id}`);
  // The automation being edited; saved as a whole with Save.
  const model = { trigger: a.trigger, trigger_config: { ...a.trigger_config }, conditions: a.conditions.map((c) => ({ ...c })), actions: a.actions.map((x) => ({ ...x })) };
  let selected = isNew ? 'trigger' : null; // 'trigger' | 'conditions' | action index
  let dirty = false;

  const name = h('input', { id: 'au-name', value: a.name, required: true, placeholder: 'e.g. Settled: thank-you text' });
  const description = h('input', { id: 'au-desc', value: a.description || '' });
  const unsaved = h('span.badge.warn', { hidden: true }, 'Unsaved changes');
  const changed = () => { dirty = true; unsaved.hidden = false; };
  name.addEventListener('input', changed);
  description.addEventListener('input', changed);

  const canvas = h('div.flow', { role: 'list', 'aria-label': 'Automation steps' });
  const panel = h('aside.flow-panel', { 'aria-live': 'polite' });
  const narrow = window.matchMedia('(max-width: 999px)');
  const nodes = new Map(); // key → the node's content element, to refresh its summary while typing

  // ---- The diagram ----
  const plus = (index, text) => h('button.flow-add', { type: 'button', title: 'Add a step here', 'aria-label': text || 'Add a step here', onclick: () => pickAction(index) }, h('span', '+'), text ? h('span.flow-add-text', text) : null);
  const connector = (index, delay) => h('div.flow-link', h('span.flow-line'), delay ? h('span.flow-wait', `⏱ wait ${delay} day${Number(delay) === 1 ? '' : 's'}`) : null, plus(index), h('span.flow-line'));

  const nodeBody = (key) => {
    if (key === 'trigger') {
      return [h('div.flow-kicker', 'When'), h('div.flow-title', triggerLabel(model.trigger)), h('div.flow-sub', triggerDetail(model.trigger, model.trigger_config))];
    }
    if (key === 'conditions') {
      return model.conditions.length
        ? [h('div.flow-kicker', 'Only if (all must match)'), h('ul.flow-conds', model.conditions.map((c) => h('li', conditionText(c))))]
        : [h('div.flow-kicker', 'Only if'), h('div.flow-sub', 'Every time. Click to add a condition, e.g. only when the deal moves to Settled.')];
    }
    const x = model.actions[key];
    const issue = problem(x);
    return [
      h('div.flow-kicker', `Step ${key + 1}`),
      h('div.flow-title', h('span.flow-icon', { 'aria-hidden': 'true' }, ACTIONS[x.type]?.icon || '•'), actionLabel(x.type)),
      describe(x) ? h('div.flow-sub', describe(x)) : null,
      issue ? h('div.flow-issue', `⚠ ${issue}`) : null,
    ];
  };

  const node = (key, cls, tools = null) => {
    const content = h('div.flow-node-main', nodeBody(key));
    nodes.set(key, content);
    const el = h(`div.flow-node.${cls}${selected === key ? '.selected' : ''}`, { role: 'listitem' },
      h('button.flow-node-btn', { type: 'button', 'aria-pressed': String(selected === key), onclick: () => select(key) }, content),
      tools);
    return el;
  };

  const actionTools = (i) => h('div.flow-tools',
    h('button.icon', { type: 'button', title: 'Move up', 'aria-label': 'Move step up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
    h('button.icon', { type: 'button', title: 'Move down', 'aria-label': 'Move step down', disabled: i === model.actions.length - 1, onclick: () => move(i, 1) }, '↓'),
    h('button.icon', { type: 'button', title: 'Duplicate', 'aria-label': 'Duplicate step', onclick: () => duplicate(i) }, '⧉'),
    h('button.icon', { type: 'button', title: 'Delete', 'aria-label': 'Delete step', onclick: () => removeAction(i) }, '×'));

  function renderFlow() {
    nodes.clear();
    const parts = [
      node('trigger', 'when'),
      h('div.flow-link', h('span.flow-line')),
      node('conditions', `cond${model.conditions.length ? '' : '.empty'}`),
    ];
    model.actions.forEach((x, i) => {
      parts.push(connector(i, x.delay_days));
      parts.push(node(i, `g-${ACTIONS[x.type]?.group || 'admin'}`, actionTools(i)));
    });
    parts.push(h('div.flow-link', h('span.flow-line')));
    parts.push(plus(model.actions.length, model.actions.length ? 'Add another step' : 'Add the first step'));
    parts.push(h('div.flow-end', 'End'));
    canvas.replaceChildren(...parts);
    placePanel();
  }

  // Side panel on wide screens; under the chosen step on narrow ones.
  function placePanel() {
    if (narrow.matches && selected !== null) {
      const content = nodes.get(selected);
      content?.closest('.flow-node')?.after(panel);
    } else if (!narrow.matches && panel.parentElement !== sideCol) {
      sideCol.append(panel);
    }
    panel.hidden = narrow.matches && selected === null;
  }
  const refreshNode = (key) => {
    const content = nodes.get(key);
    if (content) content.replaceChildren(...nodeBody(key).filter(Boolean));
  };

  function select(key) {
    selected = key;
    renderFlow();
    renderPanel();
    if (narrow.matches) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- Changing steps ----
  function insertAction(index, action) {
    model.actions.splice(index, 0, { ...action });
    changed();
    select(index);
  }
  function move(i, by) {
    const [x] = model.actions.splice(i, 1);
    model.actions.splice(i + by, 0, x);
    changed();
    select(i + by);
  }
  function duplicate(i) { insertAction(i + 1, model.actions[i]); }
  async function removeAction(i) {
    if (!(await confirmDialog(`Delete step ${i + 1} (${actionLabel(model.actions[i].type)})?`))) return;
    model.actions.splice(i, 1);
    changed();
    selected = null;
    renderFlow();
    renderPanel();
  }

  // The "+" menu: suggestions first, then every kind of step.
  function pickAction(index) {
    const choose = (action) => { d.close(); insertAction(index, action); };
    const card = (icon, title, hint, action, cls = '') => h(`button.pick-card${cls}`, { type: 'button', onclick: () => choose(action) },
      h('span.pick-icon', { 'aria-hidden': 'true' }, icon), h('span.pick-text', h('strong', title), hint ? h('span.small.muted', hint) : null));
    const body = h('div.picker',
      h('h3', 'Suggestions'),
      h('div.pick-grid', SUGGESTIONS.map((sg) => card(sg.icon, sg.title, describe(sg.action), sg.action, '.suggest'))),
      Object.entries(GROUPS).map(([g, title]) => [
        h('h3', title),
        h('div.pick-grid', Object.entries(ACTIONS).filter(([, v]) => v.group === g).map(([type, v]) => card(v.icon, v.label, v.hint, defaultsFor(type), `.g-${g}`))),
      ]).flat());
    const d = modal(index === model.actions.length ? 'Add a step' : `Add a step before step ${index + 1}`, body, { wide: true });
  }
  const defaultsFor = (type) => ({
    create_task: { type, due_in_days: 0, priority: 'normal', assign_to: 'owner' },
    send_email: { type, to: 'contact' },
    email_broker: { type, user: 'owner' },
    send_fact_find: { type, kind: 'full' },
  }[type] || { type });

  // ---- The panel for the chosen step ----
  function renderPanel() {
    if (selected === null) {
      panel.replaceChildren(h('div.flow-panel-empty',
        h('strong', 'Click a step to change it'),
        h('p.small.muted', 'Use + between the steps to add one, and the arrows on a step to move it. Save when you\'re done.')));
      return;
    }
    if (selected === 'trigger') return panel.replaceChildren(...triggerPanel());
    if (selected === 'conditions') return panel.replaceChildren(...conditionsPanel());
    return panel.replaceChildren(...actionPanel(selected));
  }

  const panelHead = (title, sub) => h('div.flow-panel-head', h('h2', title), sub ? h('p.small.muted', sub) : null,
    h('button.icon.flow-panel-close', { type: 'button', 'aria-label': 'Close', onclick: () => { selected = null; renderFlow(); renderPanel(); } }, '×'));

  function triggerPanel() {
    const sel = h('select', { id: 'au-trigger' },
      h('optgroup', { label: 'When something happens' }, meta.event_triggers.map((t) => h('option', { value: t.key, selected: t.key === model.trigger }, cleanTrigger(t.label)))),
      h('optgroup', { label: 'On a schedule' }, meta.scheduled_triggers.map((t) => h('option', { value: t.key, selected: t.key === model.trigger }, cleanTrigger(t.label)))));
    const configBox = h('div');
    const renderConfig = () => {
      const t = model.trigger;
      const before = /_expiry|finance_due|settlement_upcoming|appointment_upcoming|annual_review/.test(t);
      const inactive = /stale_/.test(t);
      const key = before ? 'days_before' : inactive ? 'days_inactive' : null;
      model.trigger_config = key ? { [key]: model.trigger_config[key] ?? (before ? 30 : 7) } : {};
      if (!key) return configBox.replaceChildren();
      const input = h('input', { id: 'au-days', type: 'number', min: before ? 0 : 1, value: model.trigger_config[key] });
      input.addEventListener('input', () => { model.trigger_config[key] = Number(input.value); changed(); refreshNode('trigger'); });
      configBox.replaceChildren(h('label.field', h('span', before ? 'Days before the date' : 'Days without activity'), input));
    };
    sel.addEventListener('change', () => { model.trigger = sel.value; renderConfig(); changed(); refreshNode('trigger'); });
    renderConfig();
    return [panelHead('When', 'What starts this automation.'), h('label.field', h('span', 'Trigger'), sel), configBox,
      h('p.small.muted', 'Events run straight away. Scheduled triggers are checked every few minutes and fire once per record and date.')];
  }

  function conditionsPanel() {
    const list = h('div.cond-list');
    const fieldOptions = (current) => [...Object.entries(FIELD_LABELS), ...(current && !FIELD_LABELS[current] ? [[current, current]] : [])];
    const row = (c) => {
      const field = h('select', { 'aria-label': 'Field' }, fieldOptions(c.field).map(([k, v]) => h('option', { value: k, selected: k === c.field }, v)));
      const op = h('select', { 'aria-label': 'Test' }, meta.operators.map((o) => h('option', { value: o, selected: o === c.op }, OP_LABELS[o] || o)));
      const valueBox = h('div.cond-value-box');
      const renderValue = () => {
        if (NO_VALUE.includes(c.op)) return valueBox.replaceChildren();
        const choices = STAGE_FIELDS.includes(c.field) ? state.meta.stages.map((s) => [s.key, s.label]) : STATUS_FIELDS.includes(c.field) ? CONTACT_STATUSES.map((s) => [s, label(s)]) : null;
        if (choices && (c.op === 'eq' || c.op === 'neq')) {
          const sel = h('select', { 'aria-label': 'Value' }, h('option', { value: '' }, 'Choose…'), choices.map(([k, v]) => h('option', { value: k, selected: k === c.value }, v)));
          sel.addEventListener('change', () => { c.value = sel.value; update(); });
          return valueBox.replaceChildren(sel);
        }
        if (choices) {
          // "is one of": tick boxes
          const picked = new Set(String(c.value || '').split(',').map((v) => v.trim()).filter(Boolean));
          return valueBox.replaceChildren(h('div.cond-ticks', choices.map(([k, v]) => {
            const box = h('input', { type: 'checkbox', checked: picked.has(k) });
            box.addEventListener('change', () => { if (box.checked) picked.add(k); else picked.delete(k); c.value = [...picked].join(','); update(); });
            return h('label.check', box, v);
          })));
        }
        const input = h('input', { 'aria-label': 'Value', value: c.value ?? '', placeholder: c.op === 'in' || c.op === 'not_in' ? 'e.g. purchase, refinance' : 'value' });
        input.addEventListener('input', () => { c.value = input.value; update(); });
        return valueBox.replaceChildren(input);
      };
      const update = () => { changed(); refreshNode('conditions'); };
      field.addEventListener('change', () => { c.field = field.value; c.value = ''; renderValue(); update(); });
      op.addEventListener('change', () => { c.op = op.value; renderValue(); update(); });
      renderValue();
      const el = h('div.cond-card', h('div.cond-line', field, op), valueBox,
        h('button.link.small.text-danger', { type: 'button', onclick: () => { model.conditions.splice(model.conditions.indexOf(c), 1); el.remove(); update(); } }, 'Remove'));
      return el;
    };
    for (const c of model.conditions) list.append(row(c));
    const add = h('button.secondary.small', { type: 'button', onclick: () => { const c = { field: 'event.to_stage', op: 'eq', value: '' }; model.conditions.push(c); list.append(row(c)); changed(); refreshNode('conditions'); } }, '+ Add condition');
    return [panelHead('Only if', 'Leave empty to run every time. With more than one, all must match.'), list, add];
  }

  function actionPanel(i) {
    const x = model.actions[i];
    const box = h('div.action-fields');
    const typeSel = h('select', { 'aria-label': 'Kind of step' }, Object.entries(ACTIONS).filter(([t]) => meta.action_types.includes(t)).map(([t, v]) => h('option', { value: t, selected: t === x.type }, v.label)));
    const renderFields = () => {
      box.replaceChildren(...actionFieldDefs(x.type).map(([fname, text, kind, options]) => {
        const v = x[fname] === undefined ? '' : (fname === 'marketing' ? (x.marketing ? 'true' : '') : x[fname]);
        const input = kind === 'select'
          ? h('select', { name: fname }, options.map(([ov, ol]) => h('option', { value: ov, selected: String(ov) === String(v) }, ol)))
          : kind === 'textarea' ? h('textarea', { name: fname, rows: 4 }, v) : h('input', { name: fname, type: kind, value: v, min: kind === 'number' ? 0 : undefined });
        input.addEventListener(kind === 'select' ? 'change' : 'input', () => {
          const val = input.value;
          if (val === '') delete x[fname];
          else if (fname === 'marketing') x.marketing = val === 'true';
          else x[fname] = kind === 'number' || fname === 'template_id' ? Number(val) : val;
          changed();
          // A changed wait moves the "wait" label on the line above the step.
          if (fname === 'delay_days') { renderFlow(); } else refreshNode(i);
        });
        return h(`label.field${kind === 'textarea' ? '.span-all' : ''}`, h('span', text), input, kind === 'textarea' && x.type === 'send_sms' ? counted(input) : null);
      }));
    };
    typeSel.addEventListener('change', () => {
      model.actions[i] = defaultsFor(typeSel.value);
      changed();
      renderFlow();
      renderPanel();
    });
    renderFields();
    return [panelHead(`Step ${i + 1}`, ACTIONS[x.type]?.hint),
      h('label.field', h('span', 'Kind of step'), typeSel), box,
      ['send_email', 'send_sms', 'create_task', 'email_broker', 'send_fact_find', 'add_note', 'notify'].includes(x.type) ? h('details.small', h('summary', 'Merge fields you can use'), h('p.muted', MERGE_HELP)) : null,
      h('div.flow-panel-actions',
        h('button.secondary.small', { type: 'button', onclick: () => duplicate(i) }, 'Duplicate'),
        h('button.danger.ghost.small', { type: 'button', onclick: () => removeAction(i) }, 'Delete step'))];
  }

  // ---- Save / delete ----
  const save = async () => {
    const body = { name: name.value.trim(), description: description.value.trim(), trigger: model.trigger, trigger_config: model.trigger_config, conditions: model.conditions.filter((c) => c.field), actions: model.actions };
    if (!body.name) { name.focus(); return toast('Give the automation a name', 'error'); }
    if (!body.actions.length) return toast('Add at least one step with +', 'error');
    const bad = body.actions.findIndex((x) => problem(x));
    if (bad > -1) { select(bad); return toast(`Step ${bad + 1}: ${problem(body.actions[bad])}`, 'error'); }
    try {
      const saved = await attempt(() => api(isNew ? '/automations' : `/automations/${id}`, { method: isNew ? 'POST' : 'PATCH', body }), 'Automation saved');
      dirty = false;
      unsaved.hidden = true;
      if (isNew) location.hash = `#/automations/${saved.id}`;
    } catch { /* toasted */ }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Delete automation "${a.name}"?`))) return;
    await attempt(() => api(`/automations/${id}`, { method: 'DELETE' }), 'Deleted');
    dirty = false;
    location.hash = '#/automations';
  };
  // Don't lose changes by closing the tab.
  const beforeUnload = (e) => { if (dirty && document.contains(canvas)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  narrow.addEventListener('change', () => { if (document.contains(canvas)) placePanel(); });

  const sideCol = h('div.flow-side');
  renderFlow();
  renderPanel();

  return h('div',
    pageHeader(isNew ? 'New automation' : a.name,
      unsaved,
      h('a.button.secondary', { href: '#/automations' }, 'Back'),
      isNew ? null : h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete'),
      h('button', { type: 'button', onclick: save }, 'Save')),
    h('section.card',
      h('div.grid-form',
        h('div.field', h('label', { for: 'au-name' }, 'Name *'), name),
        h('div.field', h('label', { for: 'au-desc' }, 'Description'), description))),
    h('div.flow-layout', h('section.card.flow-card', canvas), sideCol),
    isNew ? null : h('section.card', h('h2', 'Run history'), table([
      { label: 'When', value: (r) => dateTime(r.created_at) },
      { label: 'Record', value: (r) => (r.entity_id ? h('a', { href: `#/${r.entity_type}s/${r.entity_id}` }, `${label(r.entity_type)} #${r.entity_id}`) : '—') },
      { label: 'Result', value: (r) => h('div', badge(r.status, r.status === 'success' ? 'ok' : 'danger'), h('pre.small', r.detail)) },
    ], a.runs, { empty: 'This automation has not run yet.' })));
}
