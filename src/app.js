'use strict';
const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { STAGES, DOCUMENT_CHECKLIST } = require('./constants');
const { HttpError } = require('./util');

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
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'",
    );
    next();
  });

  // Spreadsheet uploads arrive as base64 JSON and can be larger.
  app.use('/api/import', express.json({ limit: '30mb' }));
  app.use('/api/social/images', express.json({ limit: '12mb' })); // pictures up to 8 MB, sent as base64
  app.use('/api/deals/:id/settlement-letter/read', express.json({ limit: '34mb' })); // loan documents up to 24 MB, sent as base64
  app.use('/api/signing/requests', express.json({ limit: '15mb' })); // documents up to 10 MB, sent as base64
  app.use('/api/public/fact-find', express.json({ limit: '22mb' })); // client documents up to 15 MB, sent as base64
  app.use('/api', express.json({ limit: '5mb' }));

  const brandingRoutes = require('./routes/branding');
  app.use(brandingRoutes.publicRouter);

  // CSRF defence in addition to SameSite cookies: state-changing API calls must
  // be JSON, which a cross-site HTML form cannot send.
  // (A DELETE with no body is allowed: browsers won't send one cross-site
  // without a CORS preflight, which this app never grants.)
  app.use('/api', (req, res, next) => {
    const bodylessDelete = req.method === 'DELETE' && !req.headers['content-type'] && !Number(req.headers['content-length'] || 0) && !req.headers['transfer-encoding'];
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !bodylessDelete && !req.is('application/json')) {
      return res.status(415).json({ error: 'Requests must be sent as application/json' });
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', require('./routes/auth'));
  const outlookRoutes = require('./routes/outlook');
  app.use('/api/outlook', outlookRoutes.publicRouter);
  const socialRoutes = require('./routes/social');
  app.use('/api/social', socialRoutes.publicRouter);
  const newsletterRoutes = require('./routes/newsletters');
  app.use('/api/public', newsletterRoutes.publicRouter);
  const partnerNewsletterRoutes = require('./routes/partnerNewsletters');
  app.use('/api/public', partnerNewsletterRoutes.publicRouter);
  const factFindRoutes = require('./routes/factFinds');
  app.use('/api/public/fact-find', factFindRoutes.publicRouter);

  app.use('/api', auth.requireAuth);
  app.get('/api/meta', (req, res) => res.json({
    stages: STAGES,
    document_checklist: DOCUMENT_CHECKLIST,
    party_roles: Object.entries(require('./services/parties').ROLES).map(([key, r]) => ({ key, label: r.label, types: r.types })),
    email_graphics: require('./services/emailGraphics').GRAPHICS,
  }));
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
  app.use('/api/outlook', outlookRoutes.router);
  app.use('/api/emails', outlookRoutes.emails);
  app.use('/api/sms', require('./routes/sms'));
  app.use('/api/import', require('./routes/import'));
  app.use('/api/tracker', require('./routes/tracker'));
  app.use('/api/reviews', require('./routes/reviews'));
  const calendar = require('./routes/calendar');
  app.use('/api/calendly', calendar.calendlyRouter);
  app.use('/api/signing', require('./routes/signing'));
  app.use('/api/ai', require('./routes/ai'));
  app.use('/api/quickli', require('./routes/quickli'));
  app.use('/api/agent', require('./routes/agent'));
  app.use('/api/leads', require('./routes/leads'));
  app.use('/api/property-reports', require('./routes/propertyReports'));
  app.use('/api/fact-finds', factFindRoutes.router);
  app.use('/api/newsletters', newsletterRoutes.router);
  app.use('/api/partner-newsletters', partnerNewsletterRoutes.router);
  app.use('/api/social', socialRoutes.router);
  app.use('/api/appointments', calendar.appointments);
  app.use('/api/branding', brandingRoutes.router);
  app.use('/api/signature', brandingRoutes.signature);
  app.use('/api/email-preview', brandingRoutes.preview);
  app.use('/api', require('./routes/insights'));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The client's fact-find page (its own branded page, not the CRM).
  app.get('/f/:token', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'public', 'factfind.html'));
  });
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
    // Unexpected errors are logged and hidden; deliberate ones (HttpError,
    // e.g. "Calendly rejected the token") keep their message.
    if (status >= 500 && !(err instanceof HttpError)) {
      console.error(err);
      message = 'Something went wrong';
    }
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
