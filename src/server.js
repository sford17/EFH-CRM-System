'use strict';
const db = require('./db');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');
const { seedDefaults } = require('./db/seed');

db.open();
seedDefaults();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = createApp().listen(port, host, () => {
  const shown = host === '127.0.0.1' ? 'localhost' : host;
  console.log(`EFH CRM running at http://${shown}:${port}`);
  if (process.env.SCHEDULER !== 'off') scheduler.start();
});

// On shutdown (Ctrl+C, or the server restarting for an update), finish
// what's in progress and save the database cleanly.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping the CRM…');
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => { db.close(); process.exit(0); }, 8000).unref();
  });
}
