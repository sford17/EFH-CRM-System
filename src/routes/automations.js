'use strict';
const express = require('express');
const db = require('../db');
const automation = require('../services/automation');
const { EVENT_TRIGGERS, SCHEDULED_TRIGGERS, ACTION_TYPES, STAGES } = require('../constants');
const { HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const router = express.Router();
const TRIGGERS = [...EVENT_TRIGGERS, ...SCHEDULED_TRIGGERS].map((t) => t.key);
const OPS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'has_tag', 'empty', 'not_empty'];

function validate(body, partial) {
  const row = pick(body, ['name', 'description', 'trigger', 'trigger_config', 'conditions', 'actions', 'enabled']);
  if (!partial) requireFields(row, ['name', 'trigger']);
  if (row.trigger && !TRIGGERS.includes(row.trigger)) throw new HttpError(400, `Unknown trigger "${row.trigger}"`);
  for (const key of ['trigger_config', 'conditions', 'actions']) {
    if (row[key] === undefined) continue;
    let value = row[key];
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new HttpError(400, `${key} must be valid JSON`); }
    }
    if (key === 'trigger_config' && (value === null || typeof value !== 'object' || Array.isArray(value))) value = {};
    if (key !== 'trigger_config' && !Array.isArray(value)) throw new HttpError(400, `${key} must be a list`);
    if (key === 'conditions') {
      for (const c of value) {
        if (!c.field || !OPS.includes(c.op || 'eq')) throw new HttpError(400, `Invalid condition ${JSON.stringify(c)}`);
      }
    }
    if (key === 'actions') {
      for (const a of value) {
        if (!ACTION_TYPES.includes(a.type)) throw new HttpError(400, `Unknown action type "${a.type}"`);
        if (a.type === 'send_sms' && !String(a.message || '').trim()) throw new HttpError(400, 'send_sms actions need a message');
        if (a.type === 'send_email' && !db.one('SELECT 1 FROM email_templates WHERE id = ?', Number(a.template_id) || 0)) {
          throw new HttpError(400, 'send_email actions need a valid template_id');
        }
      }
    }
    row[key] = JSON.stringify(value);
  }
  return row;
}

router.get('/meta', (req, res) => {
  res.json({ event_triggers: EVENT_TRIGGERS, scheduled_triggers: SCHEDULED_TRIGGERS, action_types: ACTION_TYPES, operators: OPS, stages: STAGES });
});

router.get('/', (req, res) => {
  res.json({ rows: db.all('SELECT * FROM automations ORDER BY trigger, id').map(automation.hydrate) });
});

router.get('/runs', (req, res) => {
  res.json({
    rows: db.all(
      `SELECT r.*, a.name AS automation_name FROM automation_runs r JOIN automations a ON a.id = r.automation_id
       ORDER BY r.id DESC LIMIT ?`,
      Math.min(Number(req.query.limit) || 100, 500),
    ),
  });
});

router.get('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const auto = automation.hydrate(notFound(db.one('SELECT * FROM automations WHERE id = ?', id), 'Automation'));
  auto.runs = db.all('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY id DESC LIMIT 50', id);
  res.json(auto);
});

router.post('/', (req, res) => {
  const id = db.insert('automations', validate(req.body, false));
  res.status(201).json(automation.hydrate(db.one('SELECT * FROM automations WHERE id = ?', id)));
});

router.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM automations WHERE id = ?', id), 'Automation');
  db.update('automations', id, validate(req.body, true));
  res.json(automation.hydrate(db.one('SELECT * FROM automations WHERE id = ?', id)));
});

router.delete('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM automations WHERE id = ?', id), 'Automation');
  db.run('DELETE FROM automations WHERE id = ?', id);
  res.json({ ok: true });
});

// Runs all scheduled automations now (normally done by the background scheduler).
router.post('/run-scheduled', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.date || '') ? req.body.date : undefined;
  res.json({ results: automation.runScheduled(date) });
});

module.exports = router;
