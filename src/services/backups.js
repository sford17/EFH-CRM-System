'use strict';
// Automatic backups of the CRM's data: the database (clients, deals,
// documents, settings) and secret.key (which unlocks saved passwords and
// connections). Each backup is a folder holding both files, so restoring is
// just copying them back. A daily backup runs at the chosen time, one is made
// before every update, and old ones are tidied up.
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const db = require('../db');
const { nowIso, today, HttpError } = require('../util');

const NAME = /^crm-backup-(\d{4}-\d{2}-\d{2})_(\d{4})(?:-(manual|update))?$/;
const DEFAULTS = { backup_enabled: '1', backup_time: '23:00', backup_folder: '', backup_keep_days: '14', backup_keep_months: '12' };
const KEEP_UPDATE = 5;
const setting = (k) => db.getSetting(k, DEFAULTS[k]) ?? DEFAULTS[k];
const TZ = () => process.env.TZ_BUSINESS || 'Australia/Sydney';

const dataDir = () => {
  const f = db.file();
  return f && f !== ':memory:' ? path.dirname(path.resolve(f)) : null;
};
const defaultFolder = () => (dataDir() ? path.join(dataDir(), 'backups') : null);
// A saved folder that doesn't make sense on this computer (e.g. a Windows
// path after moving to a Linux server) is ignored in favour of the default.
const customFolder = () => {
  const f = setting('backup_folder');
  return f && path.isAbsolute(f) && !(process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(f)) ? f : '';
};
const folder = () => customFolder() || defaultFolder();

// Local time (HH:MM) in the business time zone.
const localTime = (now = new Date()) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
const stamp = (now = new Date()) => `${today(now)}_${localTime(now).replace(':', '')}`;

function settings() {
  const dir = folder();
  const data = dataDir();
  return {
    enabled: setting('backup_enabled') !== '0',
    time: /^\d{2}:\d{2}$/.test(setting('backup_time')) ? setting('backup_time') : DEFAULTS.backup_time,
    folder: dir, custom_folder: Boolean(customFolder()), default_folder: defaultFolder(),
    ignored_folder: setting('backup_folder') && !customFolder() ? setting('backup_folder') : null,
    // A copy on the same drive won't survive the computer being lost or failing.
    same_drive: Boolean(dir && data && path.parse(path.resolve(dir)).root.toLowerCase() === path.parse(data).root.toLowerCase() && !customFolder()),
    keep_days: Number(setting('backup_keep_days')) || 14,
    keep_months: Number(setting('backup_keep_months')) || 0,
    last_ok_at: db.getSetting('backup_last_ok_at', '') || null,
    last_error: db.getSetting('backup_last_error', '') || null,
    last_attempt_at: db.getSetting('backup_last_attempt_at', '') || null,
  };
}

function checkFolder(dir) {
  const full = path.resolve(dir);
  try {
    fs.mkdirSync(full, { recursive: true });
    const probe = path.join(full, `.crm-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new HttpError(400, `The CRM can't save to that folder (${err.code || err.message}). Check the folder exists and you can save files there.`);
  }
  const data = dataDir();
  if (data && (full === data)) throw new HttpError(400, 'Choose a folder other than the data folder itself');
  return full;
}

function saveSettings(body = {}) {
  if (body.enabled !== undefined) db.setSetting('backup_enabled', body.enabled ? '1' : '0');
  if (body.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) throw new HttpError(400, 'Enter a time like 23:00');
    db.setSetting('backup_time', String(body.time));
  }
  if (body.folder !== undefined) {
    const f = String(body.folder || '').trim();
    db.setSetting('backup_folder', f ? checkFolder(f) : '');
  }
  for (const [k, key, max] of [['keep_days', 'backup_keep_days', 365], ['keep_months', 'backup_keep_months', 120]]) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < (k === 'keep_days' ? 1 : 0) || n > max) throw new HttpError(400, k === 'keep_days' ? 'Keep daily backups for 1 to 365 days' : 'Keep monthly backups for 0 to 120 months');
    db.setSetting(key, String(n));
  }
  return settings();
}

// ---- Making a backup -------------------------------------------------------------------------------

const sizeOf = (dir) => fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);

// Checks the copied database opens and isn't damaged.
function verify(file) {
  const copy = new sqlite.DatabaseSync(file);
  try {
    // One self-contained file (no -wal/-shm companions), so restoring is a single copy.
    copy.exec('PRAGMA journal_mode = DELETE');
    const r = copy.prepare('PRAGMA quick_check').get();
    if (Object.values(r)[0] !== 'ok') throw new Error('the copy failed its integrity check');
    return copy.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  } finally {
    copy.close();
  }
}

async function run({ kind = 'daily', userId = null } = {}) {
  const dir = folder();
  if (!dir) throw new HttpError(400, 'There\'s no database file to back up');
  const name = `crm-backup-${stamp()}${kind === 'manual' || kind === 'update' ? `-${kind}` : ''}`;
  const target = path.join(dir, name);
  db.setSetting('backup_last_attempt_at', nowIso());
  try {
    fs.mkdirSync(target, { recursive: true });
    const dbCopy = path.join(target, 'crm.db');
    if (fs.existsSync(dbCopy)) fs.unlinkSync(dbCopy);
    // A consistent copy while the CRM keeps running.
    await sqlite.backup(db.get(), dbCopy);
    const contacts = verify(dbCopy);
    const key = path.join(dataDir(), 'secret.key');
    if (fs.existsSync(key)) fs.copyFileSync(key, path.join(target, 'secret.key'));
    fs.writeFileSync(path.join(target, 'README.txt'), [
      `EFH CRM backup – ${new Date().toLocaleString('en-AU', { timeZone: TZ() })}`,
      `${contacts} contacts.`,
      '',
      'To restore: stop the CRM, then copy crm.db and secret.key from this folder into the CRM\'s data folder (replacing the files there), and start the CRM again.',
      'Keep this folder private: it contains your clients\' personal and financial information.',
    ].join('\r\n'));
    db.setSetting('backup_last_ok_at', nowIso());
    db.setSetting('backup_last_error', '');
    if (kind === 'daily') prune();
    return { name, folder: target, size: sizeOf(target), contacts };
  } catch (err) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* nothing to tidy */ }
    const message = err instanceof HttpError ? err.message : `The backup failed: ${err.message || err}`;
    db.setSetting('backup_last_error', message);
    if (kind === 'daily') alert(message);
    if (userId || kind === 'manual') throw new HttpError(500, message);
    return null;
  }
}

// Tells the admins (once a day) when the automatic backup didn't work.
function alert(message) {
  const day = today();
  if (db.getSetting('backup_alerted', '') === day) return;
  db.setSetting('backup_alerted', day);
  for (const u of db.all("SELECT id, name, email FROM users WHERE active = 1 AND role = 'admin'")) {
    db.insert('notifications', { user_id: u.id, message: `The automatic backup didn't work: ${message}`, link: '#/settings' });
    if (u.email) {
      try {
        require('./mailer').queueEmail({
          to: u.email, subject: 'Your CRM backup didn\'t work', internal: true, senderUserId: u.id,
          body: `Hi ${u.name.split(' ')[0]},\n\nTonight's automatic backup of the CRM didn't work:\n\n${message}\n\nPlease check the backup folder in Settings → Backups, then press "Back up now".`,
        });
      } catch { /* no email set up */ }
    }
  }
}

// ---- Listing and tidying up ---------------------------------------------------------------------------

function list() {
  const dir = folder();
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => {
    const [, date, time, kind] = NAME.exec(e.name);
    const full = path.join(dir, e.name);
    const files = fs.readdirSync(full).filter((f) => ['crm.db', 'secret.key'].includes(f));
    return { name: e.name, date, time: `${time.slice(0, 2)}:${time.slice(2)}`, kind: kind || 'daily', size: sizeOf(full), files, complete: files.includes('crm.db') };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

// Keeps the latest backup of each of the last N days, the first of each of the
// last N months, and the last few made before updates. Manual backups are kept.
function prune() {
  const s = settings();
  const all = list();
  const keep = new Set();
  const daily = all.filter((b) => b.kind === 'daily');
  const days = [...new Set(daily.map((b) => b.date))].slice(0, s.keep_days);
  for (const d of days) keep.add(daily.find((b) => b.date === d).name);
  const months = [...new Set(daily.map((b) => b.date.slice(0, 7)))].slice(0, s.keep_months);
  for (const m of months) keep.add([...daily].reverse().find((b) => b.date.startsWith(m)).name);
  all.filter((b) => b.kind === 'update').slice(0, KEEP_UPDATE).forEach((b) => keep.add(b.name));
  let removed = 0;
  for (const b of all) {
    if (b.kind === 'manual' || keep.has(b.name)) continue;
    fs.rmSync(path.join(folder(), b.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// A file from a backup, for downloading (checked against the list, so no other path can be read).
function file(name, which) {
  if (!['crm.db', 'secret.key'].includes(which)) throw new HttpError(404, 'Not found');
  const b = list().find((x) => x.name === name);
  if (!b || !b.files.includes(which)) throw new HttpError(404, 'Backup not found');
  return path.join(folder(), b.name, which);
}

// ---- Before an update, and the daily run ------------------------------------------------------------------

// Called when the CRM starts with database changes to apply: copies the files first.
function beforeUpdate(dbFile, rawDb, fromVersion) {
  if (!dbFile || dbFile === ':memory:' || !fromVersion || !fs.existsSync(dbFile)) return null;
  let dir;
  try {
    const row = rawDb.prepare("SELECT value FROM settings WHERE key = 'backup_folder'").get();
    dir = row?.value || path.join(path.dirname(path.resolve(dbFile)), 'backups');
  } catch {
    dir = path.join(path.dirname(path.resolve(dbFile)), 'backups');
  }
  const target = path.join(dir, `crm-backup-${stamp()}-update`);
  rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(dbFile, path.join(target, 'crm.db'));
  const key = path.join(path.dirname(path.resolve(dbFile)), 'secret.key');
  if (fs.existsSync(key)) fs.copyFileSync(key, path.join(target, 'secret.key'));
  fs.writeFileSync(path.join(target, 'README.txt'), 'Copy of the CRM\'s data made automatically just before an update. To undo the update, put the previous version of the CRM back and copy crm.db and secret.key from here into its data folder.\r\n');
  return target;
}

let busy = false;
// Scheduler: once a day, at or after the chosen time.
async function tick(now = new Date()) {
  const s = settings();
  if (!s.enabled || busy || !dataDir()) return null;
  if (localTime(now) < s.time) return null;
  const day = today(now);
  if (db.getSetting('backup_last_daily', '') === day) return null;
  // After a failure, try again an hour later rather than every few minutes.
  if (s.last_error && s.last_attempt_at && now - Date.parse(s.last_attempt_at) < 3600000) return null;
  busy = true;
  try {
    const r = await run({ kind: 'daily' });
    if (r) db.setSetting('backup_last_daily', day);
    return r;
  } finally {
    busy = false;
  }
}

// ---- Restoring a backup (e.g. moving to a new computer or server) ---------------------------------------

const crypto = require('node:crypto');
const STAGED = ['crm.db', 'secret.key'];
const stagingDir = () => path.join(dataDir(), 'restore-staging');

// Saves an uploaded file (streamed) ready to restore.
async function stage(which, req) {
  if (!STAGED.includes(which)) throw new HttpError(404, 'Not found');
  if (!dataDir()) throw new HttpError(400, 'There\'s no database file to restore into');
  fs.mkdirSync(stagingDir(), { recursive: true });
  const target = path.join(stagingDir(), which);
  await require('node:stream/promises').pipeline(req, fs.createWriteStream(target));
  const size = fs.statSync(target).size;
  if (!size) throw new HttpError(400, 'That file is empty');
  if (which === 'crm.db' && fs.readFileSync(target, { encoding: null }).subarray(0, 15).toString() !== 'SQLite format 3') {
    fs.unlinkSync(target);
    throw new HttpError(400, 'That isn\'t a CRM database file (crm.db)');
  }
  if (which === 'secret.key' && !/^[0-9a-f]{64}$/i.test(fs.readFileSync(target, 'utf8').trim())) {
    fs.unlinkSync(target);
    throw new HttpError(400, 'That isn\'t a CRM secret.key file');
  }
  return { file: which, size };
}

// Can this key open what's encrypted in the database? (null = nothing to check)
function keyFits(dbPath, keyHex) {
  const check = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = check.prepare("SELECT value FROM settings WHERE value LIKE 'v1:%' LIMIT 1").get();
    if (!row) return null;
    const [, iv, tag, data] = row.value.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]);
    return true;
  } catch {
    return false;
  } finally {
    check.close();
  }
}

// Swaps the uploaded backup in (after backing up what's there now).
async function restore(userId) {
  const dir = stagingDir();
  const stagedDb = path.join(dir, 'crm.db');
  const stagedKey = path.join(dir, 'secret.key');
  if (!fs.existsSync(stagedDb)) throw new HttpError(400, 'Upload the crm.db file first');
  let users;
  const check = new sqlite.DatabaseSync(stagedDb);
  try {
    check.exec('PRAGMA journal_mode = DELETE');
    if (Object.values(check.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new HttpError(400, 'That database file is damaged. Try another backup.');
    users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, 'That file isn\'t a CRM database');
  } finally {
    check.close();
  }
  if (!users) throw new HttpError(400, 'That database has no users, so nobody could sign in. Try another backup.');
  if (!process.env.ENCRYPTION_KEY) {
    if (fs.existsSync(stagedKey)) {
      if (keyFits(stagedDb, fs.readFileSync(stagedKey, 'utf8').trim()) === false) throw new HttpError(400, 'That secret.key doesn\'t belong to that database. Use the two files from the same backup folder.');
    } else if (keyFits(stagedDb, '0'.repeat(64)) !== null) {
      throw new HttpError(400, 'This database has saved passwords and connections, so it needs its secret.key too. Upload both files from the same backup folder.');
    }
  }
  // A copy of what's here now, just in case.
  await run({ kind: 'update', userId });
  const live = path.resolve(db.file());
  const liveKey = path.join(dataDir(), 'secret.key');
  const aside = `${live}.before-restore`;
  db.close();
  try {
    fs.renameSync(live, aside);
    for (const extra of ['-wal', '-shm']) fs.rmSync(`${live}${extra}`, { force: true });
    fs.renameSync(stagedDb, live);
    if (fs.existsSync(stagedKey)) fs.renameSync(stagedKey, liveKey);
    require('../secrets').resetKey();
    db.open(live);
    fs.rmSync(aside, { force: true });
  } catch (err) {
    // Put things back as they were.
    try { if (fs.existsSync(aside)) { fs.rmSync(live, { force: true }); fs.renameSync(aside, live); } } catch { /* best effort */ }
    require('../secrets').resetKey();
    db.open(live);
    throw new HttpError(500, `The restore didn't work, so nothing was changed: ${err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { users, contacts: db.one('SELECT COUNT(*) AS n FROM contacts').n };
}

const discardStaged = () => (dataDir() ? fs.rmSync(stagingDir(), { recursive: true, force: true }) : null);

module.exports = { settings, saveSettings, run, list, prune, file, tick, beforeUpdate, verify, NAME, stage, restore, discardStaged, keyFits };
