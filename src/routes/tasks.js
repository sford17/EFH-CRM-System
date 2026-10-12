'use strict';
const express = require('express');
const db = require('../db');
const automation = require('../services/automation');
const { today, addDays, nowIso, HttpError } = require('../util');
const { pick, requireFields, notFound, intParam } = require('./helpers');

const router = express.Router();
const FIELDS = ['title', 'description', 'due_date', 'priority', 'status', 'contact_id', 'deal_id', 'assigned_to'];

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  const status = req.query.status || 'open';
  if (status !== 'all') { where.push('t.status = ?'); params.push(status); }
  if (req.query.assigned_to === 'me') { where.push('t.assigned_to = ?'); params.push(req.user.id); }
  else if (req.query.assigned_to) { where.push('t.assigned_to = ?'); params.push(req.query.assigned_to); }
  if (req.query.contact_id) { where.push('t.contact_id = ?'); params.push(req.query.contact_id); }
  if (req.query.deal_id) { where.push('t.deal_id = ?'); params.push(req.query.deal_id); }
  const t0 = today();
  if (req.query.due === 'overdue') { where.push('t.due_date < ?'); params.push(t0); }
  if (req.query.due === 'today') { where.push('t.due_date = ?'); params.push(t0); }
  if (req.query.due === 'week') { where.push('t.due_date <= ?'); params.push(addDays(t0, 7)); }
  const rows = db.all(
    `SELECT t.*, u.name AS assigned_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name,
            d.title AS deal_title, a.name AS automation_name
     FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN contacts c ON c.id = t.contact_id
     LEFT JOIN deals d ON d.id = t.deal_id LEFT JOIN automations a ON a.id = t.automation_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.status, t.due_date IS NULL, t.due_date, t.priority = 'high' DESC, t.id LIMIT 500`,
    ...params,
  );
  res.json({ rows });
});

router.post('/', (req, res) => {
  const row = pick(req.body, FIELDS);
  requireFields(row, ['title']);
  if (row.deal_id && !row.contact_id) row.contact_id = db.one('SELECT contact_id FROM deals WHERE id = ?', row.deal_id)?.contact_id ?? null;
  if (row.assigned_to === undefined) row.assigned_to = req.user.id;
  const id = db.insert('tasks', { ...row, created_by: req.user.id });
  res.status(201).json(db.one('SELECT * FROM tasks WHERE id = ?', id));
});

router.patch('/:id', (req, res) => {
  const id = intParam(req.params.id);
  const before = notFound(db.one('SELECT * FROM tasks WHERE id = ?', id), 'Task');
  const row = pick(req.body, FIELDS);
  if (row.title === null) throw new HttpError(400, 'Title cannot be empty');
  if (row.status === 'done' && before.status !== 'done') row.completed_at = nowIso();
  if (row.status === 'open') row.completed_at = null;
  db.update('tasks', id, row);
  if (row.status === 'done' && before.status !== 'done') {
    if (before.contact_id) {
      db.insert('activities', {
        contact_id: before.contact_id, deal_id: before.deal_id, user_id: req.user.id, type: 'system', body: `Task completed: ${before.title}`,
      });
    }
    automation.emit('task.completed', { taskId: id, contactId: before.contact_id, dealId: before.deal_id });
  }
  res.json(db.one('SELECT * FROM tasks WHERE id = ?', id));
});

router.delete('/:id', (req, res) => {
  const id = intParam(req.params.id);
  notFound(db.one('SELECT 1 FROM tasks WHERE id = ?', id), 'Task');
  db.run('DELETE FROM tasks WHERE id = ?', id);
  res.json({ ok: true });
});

module.exports = router;
