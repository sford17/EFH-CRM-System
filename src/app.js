'use strict';
const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { STAGES, DOCUMENT_CHECKLIST } = require('./constants');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    next();
  });

  app.use('/api', express.json({ limit: '5mb' }));

  // CSRF defence in addition to SameSite cookies: state-changing API calls must
  // be JSON, which a cross-site HTML form cannot send.
  app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be sent as application/json' });
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));

  app.use('/api', auth.requireAuth);
  app.get('/api/meta', (req, res) => res.json({ stages: STAGES, document_checklist: DOCUMENT_CHECKLIST }));
  app.use('/api/contacts', require('./routes/contacts'));
  app.use('/api/deals', require('./routes/deals'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/automations', require('./routes/automations'));
  const comms = require('./routes/comms');
  app.use('/api/templates', comms.templates);
  app.use('/api/outbox', comms.outbox);
  const admin = require('./routes/admin');
  app.use('/api/users', admin.users);
  app.use('/api/settings', admin.settings);
  app.use('/api/lenders', admin.lenders);
  app.use('/api/partners', admin.partners);
  app.use('/api', require('./routes/insights'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Something went wrong';
    if (/constraint failed/i.test(message)) {
      status = 400;
      if (/UNIQUE/i.test(message)) message = 'A record with that value already exists';
      else if (/FOREIGN KEY/i.test(message)) message = 'A linked record does not exist';
      else if (/CHECK/i.test(message)) message = 'One of the values is not allowed';
      else if (/NOT NULL/i.test(message)) message = `Missing required field: ${message.split('.').pop()}`;
    }
    if (err.type === 'entity.parse.failed') { status = 400; message = 'Invalid JSON body'; }
    if (status >= 500) {
      console.error(err);
      message = 'Something went wrong';
    }
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
