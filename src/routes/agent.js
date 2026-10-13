'use strict';
const express = require('express');
const agent = require('../services/agent');
const ai = require('../services/loanDocsAI');
const { intParam } = require('./helpers');

const router = express.Router();
const me = (req) => ({ id: req.user.id, name: req.user.name, role: req.user.role });

router.get('/conversations', (req, res) => res.json({ configured: ai.configured(), rows: agent.list(req.user.id) }));
router.post('/conversations', (req, res) => res.status(201).json(agent.display(agent.load(agent.create(req.user.id), req.user.id))));
router.get('/conversations/:id', (req, res) => res.json(agent.display(agent.load(intParam(req.params.id), req.user.id))));
router.delete('/conversations/:id', (req, res) => res.json({ ok: agent.remove(intParam(req.params.id), req.user.id) }));

// Replies stream back as server-sent events: text as it's written, each
// lookup, actions to approve, then the whole conversation. A problem before
// anything is streamed comes back as an ordinary JSON error.
async function streamed(req, res, work) {
  let open = false;
  const emit = (event) => {
    if (!open) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      open = true;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    const conversation = await work(emit);
    emit({ type: 'done', conversation });
    res.end();
  } catch (err) {
    if (!open) throw err;
    emit({ type: 'error', message: err.message });
    res.end();
  }
}

router.post('/conversations/:id/messages', (req, res) => streamed(req, res, (emit) => agent.send(intParam(req.params.id), me(req), req.body?.text, emit)));
router.post('/conversations/:id/decide', (req, res) => streamed(req, res, (emit) => agent.decide(intParam(req.params.id), me(req), req.body?.decisions || {}, req.body?.edits || {}, emit)));

module.exports = router;
