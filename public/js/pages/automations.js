import { api, h, pageHeader, table, badge, dateTime, attempt, confirmDialog, label, toast, state, opts, userOptions } from '../core.js';
import { CONTACT_STATUSES } from './forms.js';
import { counted } from './sms.js';

const CONDITION_FIELDS = [
  'event.to_stage', 'event.from_stage', 'event.to_status', 'contact.status', 'contact.lead_source', 'contact.tags',
  'contact.employment_type', 'contact.state', 'contact.marketing_opt_in', 'contact.annual_income', 'deal.stage',
  'deal.loan_purpose', 'deal.loan_amount', 'deal.lvr', 'deal.lender_name', 'deal.rate_type', 'deal.priority',
  'deal.referral_partner_id', 'task.title',
];
const OP_LABELS = {
  eq: 'equals', neq: 'does not equal', in: 'is one of', not_in: 'is not one of', gt: '>', gte: '≥', lt: '<', lte: '≤',
  contains: 'contains', has_tag: 'has tag', empty: 'is empty', not_empty: 'is not empty',
};
const ACTION_LABELS = {
  create_task: 'Create a task', send_email: 'Send an email', send_sms: 'Send an SMS', add_note: 'Add a note to the timeline', add_tag: 'Add a tag',
  remove_tag: 'Remove a tag', set_contact_status: 'Set contact status', set_deal_stage: 'Move deal to stage',
  notify: 'Notify the owner', create_document_checklist: 'Add standard document checklist', generate_commissions: 'Generate commission entries',
};

let meta;
let templates;
async function loadMeta() {
  [meta, templates] = await Promise.all([api('/automations/meta'), api('/templates').then((r) => r.rows)]);
}
const triggerLabel = (key) => [...meta.event_triggers, ...meta.scheduled_triggers].find((t) => t.key === key)?.label || key;

function summarise(a) {
  const parts = a.actions.map((x) => {
    if (x.type === 'send_email') return `email "${templates.find((t) => t.id === Number(x.template_id))?.name || '?'}"${x.delay_days ? ` after ${x.delay_days}d` : ''}`;
    if (x.type === 'create_task') return `task "${x.title}"`;
    if (x.type === 'send_sms') return `SMS${x.marketing ? ' (marketing)' : ''}`;
    return ACTION_LABELS[x.type]?.toLowerCase() || x.type;
  });
  return parts.join(', ');
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
      { label: 'Automation', value: (a) => h('div', h('a', { href: `#/automations/${a.id}` }, a.name), h('div.muted.small', `When: ${triggerLabel(a.trigger)}${a.trigger_config.days_before !== undefined ? ` (${a.trigger_config.days_before} days)` : ''}${a.trigger_config.days_inactive !== undefined ? ` (${a.trigger_config.days_inactive} days)` : ''}`), h('div.muted.small', `Then: ${summarise(a)}`)) },
      { label: 'Runs', value: (a) => String(a.run_count), class: 'num' },
      { label: 'Last run', value: (a) => dateTime(a.last_run_at) },
    ], list, { empty: 'None.' }));
  };
  return h('div',
    pageHeader('Automations',
      h('button.secondary', { type: 'button', onclick: runNow }, 'Run scheduled checks now'),
      h('a.button', { href: '#/automations/new' }, '+ New automation')),
    h('p.muted', 'Event automations run instantly when something happens. Scheduled automations are checked every few minutes by the background scheduler and only fire once per record and date.'),
    group('Event automations', (a) => !a.trigger.startsWith('schedule.')),
    group('Scheduled automations', (a) => a.trigger.startsWith('schedule.')),
    h('section.card', h('h2', 'Recent runs'), table([
      { label: 'When', value: (r) => dateTime(r.created_at) },
      { label: 'Automation', value: (r) => h('a', { href: `#/automations/${r.automation_id}` }, r.automation_name) },
      { label: 'Record', value: (r) => (r.entity_id ? h('a', { href: `#/${r.entity_type}s/${r.entity_id}` }, `${label(r.entity_type)} #${r.entity_id}`) : '—') },
      { label: 'Result', value: (r) => h('div', badge(r.status, r.status === 'success' ? 'ok' : 'danger'), h('pre.small', r.detail)) },
    ], runs.rows, { empty: 'No runs yet.' })));
}

// ---- Editor -----------------------------------------------------------------

function conditionRow(c = { field: 'event.to_stage', op: 'eq', value: '' }) {
  const fieldInput = h('input', { list: 'cond-fields', value: c.field, 'aria-label': 'Field', class: 'cond-field' });
  const op = h('select', { 'aria-label': 'Operator', class: 'cond-op' }, meta.operators.map((o) => h('option', { value: o, selected: o === c.op }, OP_LABELS[o] || o)));
  const value = h('input', { value: c.value ?? '', 'aria-label': 'Value', class: 'cond-value', placeholder: 'value (comma list for "is one of")' });
  const row = h('div.builder-row.condition', fieldInput, op, value, h('button.icon', { type: 'button', 'aria-label': 'Remove condition', onclick: () => row.remove() }, '×'));
  return row;
}

function actionFieldDefs(type) {
  const templateOpts = templates.map((t) => [t.id, t.name]);
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
      ['delay_days', 'Delay (days)', 'number'],
      ['to', 'Send to', 'select', [['contact', 'Client (both borrowers on joint loans)'], ['main_contact', 'Main client only'], ['broker', 'Broker (internal)']]],
    ];
    case 'send_sms': return [
      ['message', 'Text message (merge fields allowed, e.g. {{contact.first_name}}, {{broker.first_name}})', 'textarea'],
      ['delay_days', 'Delay (days)', 'number'],
      ['marketing', 'Type', 'select', [['', 'Service update (always sent)'], ['true', 'Marketing (needs consent, adds opt-out)']]],
    ];
    case 'add_note': return [['body', 'Note', 'text']];
    case 'add_tag': case 'remove_tag': return [['tag', 'Tag', 'text']];
    case 'set_contact_status': return [['status', 'Status', 'select', opts(CONTACT_STATUSES)]];
    case 'set_deal_stage': return [['stage', 'Stage', 'select', state.meta.stages.map((s) => [s.key, s.label])]];
    case 'notify': return [['message', 'Message', 'text']];
    default: return [];
  }
}

function actionRow(a = { type: 'create_task' }) {
  const fieldsBox = h('div.action-fields');
  const renderFields = (values) => {
    fieldsBox.replaceChildren(...actionFieldDefs(typeSel.value).map(([name, text, kind, options]) => {
      const v = values[name] ?? '';
      const input = kind === 'select'
        ? h('select', { name }, options.map(([ov, ol]) => h('option', { value: ov, selected: String(ov) === String(v) }, ol)))
        : kind === 'textarea'
          ? h('textarea', { name, rows: 3 }, v)
          : h('input', { name, type: kind, value: v, min: kind === 'number' ? 0 : undefined });
      if (kind === 'textarea') return h('label.field.span-all', h('span', text), input, counted(input));
      return h('label.field', h('span', text), input);
    }));
  };
  const typeSel = h('select', { 'aria-label': 'Action type', class: 'action-type' }, meta.action_types.map((t) => h('option', { value: t, selected: t === a.type }, ACTION_LABELS[t] || t)));
  typeSel.addEventListener('change', () => renderFields({}));
  renderFields(a);
  const row = h('div.builder-row.action', h('div.action-head', typeSel, h('button.icon', { type: 'button', 'aria-label': 'Remove action', onclick: () => row.remove() }, '×')), fieldsBox);
  return row;
}

function readActions(container) {
  return [...container.querySelectorAll('.builder-row.action')].map((row) => {
    const out = { type: row.querySelector('.action-type').value };
    for (const el of row.querySelectorAll('.action-fields [name]')) {
      if (el.value === '') continue;
      if (el.name === 'marketing') out.marketing = el.value === 'true';
      else out[el.name] = el.type === 'number' || el.name === 'template_id' ? Number(el.value) : el.value;
    }
    return out;
  });
}

function readConditions(container) {
  return [...container.querySelectorAll('.builder-row.condition')].map((row) => ({
    field: row.querySelector('.cond-field').value.trim(),
    op: row.querySelector('.cond-op').value,
    value: row.querySelector('.cond-value').value,
  })).filter((c) => c.field);
}

export async function automationPage(id) {
  await loadMeta();
  const isNew = id === 'new';
  const a = isNew
    ? { name: '', description: '', trigger: 'deal.stage_changed', trigger_config: {}, conditions: [], actions: [{ type: 'create_task', due_in_days: 0 }], enabled: 1, runs: [] }
    : await api(`/automations/${id}`);

  const name = h('input', { id: 'au-name', value: a.name, required: true });
  const description = h('input', { id: 'au-desc', value: a.description || '' });
  const trigger = h('select', { id: 'au-trigger' },
    h('optgroup', { label: 'When something happens' }, meta.event_triggers.map((t) => h('option', { value: t.key, selected: t.key === a.trigger }, t.label))),
    h('optgroup', { label: 'On a schedule' }, meta.scheduled_triggers.map((t) => h('option', { value: t.key, selected: t.key === a.trigger }, t.label))));
  const configBox = h('div');
  const renderConfig = () => {
    const t = trigger.value;
    const needsBefore = /fixed_rate_expiry|pre_approval_expiry|finance_due|settlement_upcoming|appointment_upcoming/.test(t);
    const needsInactive = /stale_/.test(t);
    configBox.replaceChildren(...[
      needsBefore ? h('label.field', h('span', 'Days before the date'), h('input', { id: 'au-days', type: 'number', min: 0, value: a.trigger_config.days_before ?? 30 })) : null,
      needsInactive ? h('label.field', h('span', 'Days without activity'), h('input', { id: 'au-days', type: 'number', min: 1, value: a.trigger_config.days_inactive ?? 7 })) : null,
    ].filter(Boolean));
  };
  trigger.addEventListener('change', renderConfig);
  renderConfig();

  const conds = h('div.builder', a.conditions.map((c) => conditionRow(c)));
  const actions = h('div.builder', a.actions.map((x) => actionRow(x)));

  const save = async () => {
    const t = trigger.value;
    const days = document.getElementById('au-days');
    const trigger_config = days ? { [/stale_/.test(t) ? 'days_inactive' : 'days_before']: Number(days.value) } : {};
    const body = { name: name.value.trim(), description: description.value.trim(), trigger: t, trigger_config, conditions: readConditions(conds), actions: readActions(actions) };
    if (!body.name) return toast('Give the automation a name', 'error');
    if (!body.actions.length) return toast('Add at least one action', 'error');
    const saved = await attempt(() => api(isNew ? '/automations' : `/automations/${id}`, { method: isNew ? 'POST' : 'PATCH', body }), 'Automation saved');
    if (isNew) location.hash = `#/automations/${saved.id}`;
    else window.dispatchEvent(new Event('crm:refresh'));
  };
  const remove = async () => {
    if (!(await confirmDialog(`Delete automation "${a.name}"?`))) return;
    await attempt(() => api(`/automations/${id}`, { method: 'DELETE' }), 'Deleted');
    location.hash = '#/automations';
  };

  return h('div',
    pageHeader(isNew ? 'New automation' : a.name,
      h('a.button.secondary', { href: '#/automations' }, 'Back'),
      isNew ? null : h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete'),
      h('button', { type: 'button', onclick: save }, 'Save')),
    h('datalist#cond-fields', CONDITION_FIELDS.map((f) => h('option', { value: f }))),
    h('section.card',
      h('div.grid-form',
        h('div.field', h('label', { for: 'au-name' }, 'Name *'), name),
        h('div.field', h('label', { for: 'au-desc' }, 'Description'), description))),
    h('section.card', h('h2', '1. When'), h('div.grid-form', h('div.field', h('label', { for: 'au-trigger' }, 'Trigger'), trigger), configBox)),
    h('section.card', h('h2', '2. Only if (all must match)'),
      h('p.muted.small', 'Stages: ', state.meta.stages.map((s) => s.key).join(', ')),
      conds,
      h('button.secondary.small', { type: 'button', onclick: () => conds.append(conditionRow()) }, '+ Add condition')),
    h('section.card', h('h2', '3. Then'),
      h('p.muted.small', 'Merge fields: {{contact.first_name}}, {{contact.full_name}}, {{deal.title}}, {{deal.loan_amount|money}}, {{deal.settlement_date|date}}, {{deal.lender_name}}, {{deal.stage_label}}, {{broker.name}}, {{broker.booking_link}}. For appointment triggers: {{event.title}}, {{event.when}}, {{event.location}}, {{event.join_url}}'),
      actions,
      h('button.secondary.small', { type: 'button', onclick: () => actions.append(actionRow()) }, '+ Add action')),
    isNew ? null : h('section.card', h('h2', 'Run history'), table([
      { label: 'When', value: (r) => dateTime(r.created_at) },
      { label: 'Record', value: (r) => (r.entity_id ? h('a', { href: `#/${r.entity_type}s/${r.entity_id}` }, `${label(r.entity_type)} #${r.entity_id}`) : '—') },
      { label: 'Result', value: (r) => h('div', badge(r.status, r.status === 'success' ? 'ok' : 'danger'), h('pre.small', r.detail)) },
    ], a.runs, { empty: 'This automation has not run yet.' })));
}
