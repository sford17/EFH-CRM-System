'use strict';
const db = require('../db');
const { render, buildContext } = require('./templating');
const mailer = require('./mailer');
const sms = require('./sms');
const documents = require('./documents');
const commissions = require('./commissions');
const { STAGE_KEYS } = require('../constants');
const { today, addDays, nowIso, parseTags, parseJson, stageLabel } = require('../util');

const MAX_DEPTH = 3; // guards against automations triggering each other forever
let depth = 0;

function lookup(ctx, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);

function evaluateCondition(ctx, { field, op = 'eq', value }) {
  const actual = lookup(ctx, field);
  const num = (x) => Number(x);
  switch (op) {
    case 'eq': return String(actual ?? '') === String(value ?? '');
    case 'neq': return String(actual ?? '') !== String(value ?? '');
    case 'in': return asList(value).includes(String(actual ?? ''));
    case 'not_in': return !asList(value).includes(String(actual ?? ''));
    case 'gt': return actual != null && num(actual) > num(value);
    case 'gte': return actual != null && num(actual) >= num(value);
    case 'lt': return actual != null && num(actual) < num(value);
    case 'lte': return actual != null && num(actual) <= num(value);
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'has_tag': return parseTags(actual).map((t) => t.toLowerCase()).includes(String(value).toLowerCase());
    case 'empty': return actual === null || actual === undefined || actual === '';
    case 'not_empty': return !(actual === null || actual === undefined || actual === '');
    default: throw new Error(`Unknown condition operator "${op}"`);
  }
}

function matches(ctx, conditions) {
  return (conditions || []).every((c) => evaluateCondition(ctx, c));
}

function resolveAssignee(spec, ctx) {
  if (spec && spec !== 'owner' && Number(spec)) return Number(spec);
  return ctx.deal?.owner_id || ctx.contact?.owner_id || null;
}

// Due date for created tasks: N days from today, or from a date in the
// context (e.g. due_on: 'event.date' for the day of an appointment).
function dueDate(a, ctx) {
  const base = a.due_on ? lookup(ctx, a.due_on) : null;
  const from = /^\d{4}-\d{2}-\d{2}/.test(base || '') ? String(base).slice(0, 10) : today();
  return addDays(from, Number(a.due_in_days || 0));
}

const ACTIONS = {
  create_task(a, ctx, auto) {
    const id = db.insert('tasks', {
      title: render(a.title || 'Follow up', ctx),
      description: a.description ? render(a.description, ctx) : null,
      due_date: dueDate(a, ctx),
      priority: a.priority || 'normal',
      contact_id: ctx.contact?.id ?? null,
      deal_id: ctx.deal?.id ?? null,
      assigned_to: resolveAssignee(a.assign_to, ctx),
      automation_id: auto.id,
    });
    return `task #${id} created`;
  },
  send_email(a, ctx, auto) {
    const to = a.to === 'broker' ? ctx.broker?.email : undefined;
    const sendAfter = a.delay_days ? new Date(Date.now() + Number(a.delay_days) * 86400000).toISOString() : undefined;
    const { id, reason } = mailer.queueTemplate(a.template_id, {
      contactId: ctx.contact?.id, dealId: ctx.deal?.id, automationId: auto.id, sendAfter, to,
    });
    return id ? `email #${id} queued` : `email skipped: ${reason}`;
  },
  send_sms(a, ctx, auto) {
    if (!ctx.contact) return 'no contact';
    const sendAfter = a.delay_days ? new Date(Date.now() + Number(a.delay_days) * 86400000).toISOString() : undefined;
    const { id, reason } = sms.queueForContact({
      contactId: ctx.contact.id, dealId: ctx.deal?.id ?? null, body: render(a.message, ctx),
      marketing: Boolean(a.marketing), automationId: auto.id, senderUserId: ctx.broker?.id ?? null, sendAfter,
    });
    if (!id) return `SMS skipped: ${reason}`;
    if (!sendAfter) sms.processSoon();
    return `SMS #${id} queued`;
  },
  add_note(a, ctx) {
    db.insert('activities', {
      contact_id: ctx.contact?.id ?? null, deal_id: ctx.deal?.id ?? null, type: 'system', body: render(a.body, ctx),
    });
    return 'note added';
  },
  add_tag(a, ctx) {
    if (!ctx.contact) return 'no contact';
    const tags = parseTags(ctx.contact.tags);
    if (!tags.some((t) => t.toLowerCase() === String(a.tag).toLowerCase())) tags.push(a.tag);
    db.update('contacts', ctx.contact.id, { tags: tags.join(','), updated_at: nowIso() });
    ctx.contact.tags = tags.join(',');
    return `tag "${a.tag}" added`;
  },
  remove_tag(a, ctx) {
    if (!ctx.contact) return 'no contact';
    const tags = parseTags(ctx.contact.tags).filter((t) => t.toLowerCase() !== String(a.tag).toLowerCase());
    db.update('contacts', ctx.contact.id, { tags: tags.join(','), updated_at: nowIso() });
    ctx.contact.tags = tags.join(',');
    return `tag "${a.tag}" removed`;
  },
  set_contact_status(a, ctx) {
    if (!ctx.contact || ctx.contact.status === a.status) return 'unchanged';
    const from = ctx.contact.status;
    db.update('contacts', ctx.contact.id, { status: a.status, updated_at: nowIso() });
    ctx.contact.status = a.status;
    emit('contact.status_changed', { contactId: ctx.contact.id, from_status: from, to_status: a.status });
    return `contact status → ${a.status}`;
  },
  set_deal_stage(a, ctx) {
    if (!ctx.deal || ctx.deal.stage === a.stage) return 'unchanged';
    if (!STAGE_KEYS.includes(a.stage)) throw new Error(`Unknown stage ${a.stage}`);
    changeDealStage(ctx.deal.id, a.stage, null);
    return `deal stage → ${a.stage}`;
  },
  notify(a, ctx) {
    const userId = resolveAssignee(a.user, ctx);
    const link = ctx.deal ? `#/deals/${ctx.deal.id}` : ctx.contact ? `#/contacts/${ctx.contact.id}` : null;
    db.insert('notifications', { user_id: userId, message: render(a.message, ctx), link });
    return 'notification sent';
  },
  create_document_checklist(a, ctx) {
    if (!ctx.deal) return 'no deal';
    return `${documents.createChecklist(ctx.deal.id)} documents added`;
  },
  generate_commissions(a, ctx) {
    if (!ctx.deal) return 'no deal';
    return `${commissions.generateForDeal(ctx.deal.id)} commission entries created`;
  },
};

function hydrate(row) {
  return {
    ...row,
    trigger_config: parseJson(row.trigger_config, {}),
    conditions: parseJson(row.conditions, []),
    actions: parseJson(row.actions, []),
  };
}

// Runs one automation for one entity. Returns the run record, or null if
// conditions did not match / the run_key was already used.
function runAutomation(auto, { contactId, dealId, taskId, event = {}, runKey = null } = {}) {
  if (runKey && db.one('SELECT 1 FROM automation_runs WHERE run_key = ?', runKey)) return null;
  const ctx = buildContext({ contactId, dealId });
  ctx.event = event;
  if (taskId) ctx.task = db.one('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!matches(ctx, auto.conditions)) return null;

  const results = [];
  let status = 'success';
  depth++;
  try {
    for (const action of auto.actions) {
      const fn = ACTIONS[action.type];
      try {
        if (!fn) throw new Error(`Unknown action "${action.type}"`);
        results.push(`${action.type}: ${fn(action, ctx, auto)}`);
      } catch (err) {
        status = 'error';
        results.push(`${action.type}: ERROR ${err.message}`);
      }
    }
  } finally {
    depth--;
  }
  const entityType = dealId || ctx.deal ? 'deal' : 'contact';
  const entityId = ctx.deal?.id ?? ctx.contact?.id ?? null;
  db.insert('automation_runs', {
    automation_id: auto.id, run_key: runKey, entity_type: entityType, entity_id: entityId, status, detail: results.join('\n'),
  });
  db.run('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', nowIso(), auto.id);
  return { status, detail: results };
}

function emit(trigger, payload) {
  if (process.env.AUTOMATIONS === 'off' || depth >= MAX_DEPTH) return [];
  const autos = db.all('SELECT * FROM automations WHERE enabled = 1 AND trigger = ? ORDER BY id', trigger).map(hydrate);
  const results = [];
  for (const auto of autos) {
    const { contactId, dealId, taskId, ...event } = payload;
    const r = runAutomation(auto, { contactId, dealId, taskId, event });
    if (r) results.push({ automation: auto.name, ...r });
  }
  return results;
}

// Moves a deal to a new stage, records history, and fires automations.
function changeDealStage(dealId, toStage, userId, extra = {}) {
  const deal = db.one('SELECT * FROM deals WHERE id = ?', dealId);
  if (!deal) throw new Error('Deal not found');
  if (deal.stage === toStage) return deal;
  const now = nowIso();
  const patch = { ...extra, stage: toStage, stage_changed_at: now, updated_at: now };
  if (toStage === 'settled' && !deal.settlement_date && !extra.settlement_date) patch.settlement_date = today();
  db.update('deals', dealId, patch);
  db.insert('deal_stage_history', { deal_id: dealId, from_stage: deal.stage, to_stage: toStage, changed_by: userId });
  db.insert('activities', {
    contact_id: deal.contact_id, deal_id: dealId, user_id: userId, type: 'system',
    body: `Stage changed: ${stageLabel(deal.stage)} → ${stageLabel(toStage)}`,
  });
  emit('deal.stage_changed', { dealId, from_stage: deal.stage, to_stage: toStage });
  return db.one('SELECT * FROM deals WHERE id = ?', dealId);
}

// ---- Scheduled triggers --------------------------------------------------

const yearOf = (d) => d.slice(0, 4);

// Each finder returns [{ dealId?, contactId?, key }] for the given date.
const FINDERS = {
  'schedule.fixed_rate_expiry': (cfg, date) => db.all(
    `SELECT id AS dealId, fixed_expiry_date AS k FROM deals
     WHERE stage = 'settled' AND rate_type IN ('fixed','split') AND fixed_expiry_date BETWEEN ? AND ?`,
    date, addDays(date, cfg.days_before ?? 90),
  ),
  'schedule.pre_approval_expiry': (cfg, date) => db.all(
    `SELECT id AS dealId, pre_approval_expiry AS k FROM deals
     WHERE stage = 'pre_approval' AND pre_approval_expiry BETWEEN ? AND ?`,
    date, addDays(date, cfg.days_before ?? 14),
  ),
  'schedule.finance_due': (cfg, date) => db.all(
    `SELECT id AS dealId, finance_due_date AS k FROM deals
     WHERE stage IN ('lead','fact_find','pre_approval','application_lodged','conditional_approval')
       AND finance_due_date BETWEEN ? AND ?`,
    date, addDays(date, cfg.days_before ?? 3),
  ),
  'schedule.settlement_upcoming': (cfg, date) => db.all(
    `SELECT id AS dealId, settlement_date AS k FROM deals
     WHERE stage IN ('unconditional_approval','settlement_booked') AND settlement_date BETWEEN ? AND ?`,
    date, addDays(date, cfg.days_before ?? 2),
  ),
  'schedule.settlement_anniversary': (cfg, date) => db.all(
    `SELECT id AS dealId, ? AS k FROM deals
     WHERE stage = 'settled' AND settlement_date IS NOT NULL
       AND substr(settlement_date, 6, 5) = ? AND substr(settlement_date, 1, 4) < ?`,
    yearOf(date), date.slice(5), yearOf(date),
  ),
  'schedule.birthday': (cfg, date) => {
    const md = date.slice(5);
    const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    // People born on 29 Feb are greeted on 28 Feb in non-leap years.
    const extra = md === '02-28' && !isLeap(Number(yearOf(date))) ? ['02-29'] : [];
    const days = [md, ...extra];
    return db.all(
      `SELECT id AS contactId, ? AS k FROM contacts
       WHERE dob IS NOT NULL AND status != 'lost' AND substr(dob, 6, 5) IN (${days.map(() => '?').join(',')})`,
      yearOf(date), ...days,
    );
  },
  'schedule.review_due': (cfg, date) => db.all(
    `SELECT id AS contactId, next_review_date AS k FROM contacts
     WHERE next_review_date IS NOT NULL AND next_review_date <= ? AND status IN ('client','past_client')`,
    date,
  ),
  'schedule.stale_deal': (cfg, date) => {
    const days = cfg.days_inactive ?? 14;
    const cutoff = addDays(date, -days);
    // Repeats every `days` days while the deal stays inactive in the same stage.
    return db.all(
      `SELECT d.id AS dealId,
              d.stage_changed_at || ':' || CAST((julianday(?) - julianday(MAX(d.stage_changed_at, COALESCE(a.last_at, '')))) / ? AS INTEGER) AS k
       FROM deals d
       LEFT JOIN (SELECT deal_id, MAX(created_at) AS last_at FROM activities WHERE type != 'system' GROUP BY deal_id) a
              ON a.deal_id = d.id
       WHERE d.stage NOT IN ('settled','lost')
         AND substr(MAX(d.stage_changed_at, COALESCE(a.last_at, '')), 1, 10) <= ?`,
      date, days, cutoff,
    );
  },
  'schedule.appointment_upcoming': (cfg, date) => db.all(
    `SELECT id AS appointmentId, contact_id AS contactId, deal_id AS dealId, start_at AS k FROM appointments
     WHERE status = 'active' AND contact_id IS NOT NULL AND start_at >= ? AND start_at < ?`,
    new Date().toISOString(), `${addDays(date, (cfg.days_before ?? 1) + 1)}T00:00:00.000Z`,
  ).filter((r) => today(new Date(r.k)) <= addDays(date, cfg.days_before ?? 1)),
  'schedule.stale_lead': (cfg, date) => db.all(
    `SELECT id AS contactId, COALESCE(last_contacted_at, created_at) AS k FROM contacts
     WHERE status = 'lead' AND substr(COALESCE(last_contacted_at, created_at), 1, 10) <= ?`,
    addDays(date, -(cfg.days_inactive ?? 3)),
  ),
};

function runScheduled(date = today()) {
  if (process.env.AUTOMATIONS === 'off') return [];
  const autos = db.all("SELECT * FROM automations WHERE enabled = 1 AND trigger LIKE 'schedule.%' ORDER BY id").map(hydrate);
  const results = [];
  for (const auto of autos) {
    const finder = FINDERS[auto.trigger];
    if (!finder) continue;
    for (const row of finder(auto.trigger_config, date)) {
      const entity = row.appointmentId ? `appointment:${row.appointmentId}` : row.dealId ? `deal:${row.dealId}` : `contact:${row.contactId}`;
      const runKey = `${auto.id}:${entity}:${row.k}`;
      let event = { date };
      if (row.appointmentId) {
        const calendly = require('./calendly'); // lazy: calendly → automation
        event = { ...event, ...calendly.eventContext(db.one('SELECT * FROM appointments WHERE id = ?', row.appointmentId)) };
      }
      const r = runAutomation(auto, { dealId: row.dealId, contactId: row.contactId, runKey, event });
      if (r) results.push({ automation: auto.name, entity, ...r });
    }
  }
  return results;
}

module.exports = { emit, runScheduled, runAutomation, changeDealStage, evaluateCondition, hydrate, ACTIONS, FINDERS };
