'use strict';
const automation = require('./automation');
const mailer = require('./mailer');
const outlook = require('./outlook');
const sms = require('./sms');
const calendly = require('./calendly');
const adobeSign = require('./adobeSign');

let timer;

async function tick(log = console) {
  try {
    const results = automation.runScheduled();
    if (results.length) log.info(`[scheduler] ${results.length} scheduled automation run(s)`);
    const sent = await mailer.processOutbox();
    if (sent) log.info(`[scheduler] processed ${sent} outbox email(s)`);
    const texts = await sms.processSms();
    if (texts) log.info(`[scheduler] processed ${texts} SMS`);
    const bookings = await calendly.syncAll(log);
    if (bookings) log.info(`[scheduler] ${bookings} new Calendly booking change(s)`);
    const signed = await adobeSign.syncOpen(log);
    if (signed) log.info(`[scheduler] ${signed} Adobe Sign document(s) finished`);
    const synced = await outlook.syncAll(log);
    if (synced) log.info(`[scheduler] filed ${synced} Outlook email(s) against contacts`);
  } catch (err) {
    log.error('[scheduler] tick failed', err);
  }
}

// Scheduled automations are de-duplicated by run key, so ticking often is safe.
function start(intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 5 * 60 * 1000)) {
  stop();
  setImmediate(() => tick());
  timer = setInterval(() => tick(), intervalMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

module.exports = { start, stop, tick };
