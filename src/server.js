'use strict';
const db = require('./db');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');
const { seedDefaults } = require('./db/seed');

db.open();
seedDefaults();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
createApp().listen(port, host, () => {
  console.log(`EFH CRM running at http://${host}:${port}`);
  if (process.env.SCHEDULER !== 'off') scheduler.start();
});
