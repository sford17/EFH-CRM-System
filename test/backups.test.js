'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let srv;
let api;
let db;
let backups;
let dir;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  // Backups need a real database file (not the in-memory one other tests use).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-backup-test-'));
  db.close();
  db.open(path.join(dir, 'data', 'crm.db'));
  require('../src/db/seed').seedDefaults();
  db.insert('users', { name: 'Admin User', email: 'admin@test.local', password_hash: require('../src/auth').hashPassword('password123'), role: 'admin' });
  db.insert('contacts', { first_name: 'Mia', last_name: 'Backup' });
  fs.writeFileSync(path.join(dir, 'data', 'secret.key'), 'a'.repeat(64));
  api = srv.client();
  await api.login();
  backups = require('../src/services/backups');
});
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const at = (hhmm) => {
  // A moment that's hhmm in the business time zone today.
  const base = new Date();
  for (let m = 0; m < 48 * 60; m += 1) {
    const d = new Date(base.getTime() - 24 * 3600000 + m * 60000);
    const t = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    if (t === hhmm && require('../src/util').today(d) === require('../src/util').today()) return d;
  }
  throw new Error('no time');
};

test('back up now: a checked copy of the database and secret.key', async () => {
  const r = await api.post('/backups/run', {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.contacts, 1);
  const folder = path.join(dir, 'data', 'backups', r.data.name);
  assert.match(r.data.name, /^crm-backup-\d{4}-\d{2}-\d{2}_\d{4}-manual$/);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['README.txt', 'crm.db', 'secret.key']);
  assert.equal(fs.readFileSync(path.join(folder, 'secret.key'), 'utf8'), fs.readFileSync(path.join(dir, 'data', 'secret.key'), 'utf8'));
  const copy = new DatabaseSync(path.join(folder, 'crm.db'), { readOnly: true });
  assert.equal(copy.prepare("SELECT first_name FROM contacts WHERE last_name = 'Backup'").get().first_name, 'Mia');
  copy.close();

  const list = (await api.get('/backups')).data;
  assert.equal(list.backups[0].kind, 'manual');
  assert.ok(list.settings.last_ok_at);
  assert.equal(list.settings.same_drive, true, 'default folder is inside the data folder');

  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const dl = await fetch(`${srv.base}/backups/${r.data.name}/crm.db`, { headers: { Cookie: cookie } });
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await fetch(`${srv.base}/backups/..%2F..%2Fdata/crm.db`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${srv.base}/backups/${r.data.name}/README.txt`, { headers: { Cookie: cookie } })).status, 404);
});

test('only admins see or change backups', async () => {
  await api.post('/users', { name: 'Bea Broker', email: 'bea@test.local', password: 'password123', role: 'broker' });
  const broker = srv.client();
  await broker.login('bea@test.local', 'password123');
  assert.equal((await broker.get('/backups')).status, 403);
  assert.equal((await broker.post('/backups/run', {})).status, 403);
});

test('settings: time, a cloud folder and how long to keep them', async () => {
  assert.equal((await api.put('/backups/settings', { time: '25:00' })).status, 400);
  assert.equal((await api.put('/backups/settings', { keep_days: 0 })).status, 400);
  const notAFolder = path.join(dir, 'a-file');
  fs.writeFileSync(notAFolder, 'x');
  assert.match((await api.put('/backups/settings', { folder: path.join(notAFolder, 'sub') })).data.error, /can't save to that folder/);
  const cloud = path.join(dir, 'OneDrive', 'CRM Backups');
  const s = (await api.put('/backups/settings', { time: '22:30', folder: cloud, keep_days: 3, keep_months: 2 })).data;
  assert.deepEqual([s.time, s.folder, s.custom_folder, s.same_drive, s.keep_days, s.keep_months], ['22:30', cloud, true, false, 3, 2]);
  assert.ok(fs.existsSync(cloud));
});

test('the daily backup runs once, at or after the chosen time', async () => {
  db.setSetting('backup_last_daily', '');
  assert.equal(await backups.tick(at('22:00')), null, 'too early');
  const r = await backups.tick(at('22:45'));
  assert.ok(r, 'ran');
  assert.ok(r.folder.startsWith(path.join(dir, 'OneDrive')));
  assert.equal(await backups.tick(at('23:10')), null, 'once a day');
});

test('a failed backup is reported to admins, then retried later', async () => {
  const blocked = path.join(dir, 'blocked');
  db.setSetting('backup_folder', blocked);
  fs.writeFileSync(blocked, 'not a folder');
  db.setSetting('backup_last_daily', '');
  db.setSetting('backup_alerted', '');
  const r = await backups.tick(at('23:59'));
  assert.equal(r, null);
  const s = backups.settings();
  assert.match(s.last_error, /The backup failed/);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'The automatic backup didn''t work%'"));
  assert.ok(db.one("SELECT 1 FROM outbox WHERE subject = 'Your CRM backup didn''t work'"));
  const dash = (await api.get('/dashboard')).data;
  assert.match(dash.backup_warning, /The last backup didn't work/);
  assert.equal(await backups.tick(at('23:59')), null, 'not retried straight away');
  fs.unlinkSync(blocked);
  db.setSetting('backup_folder', path.join(dir, 'OneDrive', 'CRM Backups'));
  await api.post('/backups/run', {});
  assert.equal((await api.get('/dashboard')).data.backup_warning, null, 'cleared once a backup works');
});

test('old backups are tidied: N days, one a month, the last few updates, all manual ones', () => {
  const folder = backups.settings().folder;
  fs.rmSync(folder, { recursive: true, force: true });
  const make = (name) => { fs.mkdirSync(path.join(folder, name), { recursive: true }); fs.writeFileSync(path.join(folder, name, 'crm.db'), 'x'); };
  for (const d of ['2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10', '2026-09-20', '2026-09-02', '2026-08-15', '2026-07-01']) make(`crm-backup-${d}_2300`);
  make('crm-backup-2026-10-13_0900'); // an earlier one on the same day
  make('crm-backup-2026-01-01_1200-manual');
  for (let i = 1; i <= 7; i += 1) make(`crm-backup-2026-0${i}-05_0800-update`);
  fs.mkdirSync(path.join(folder, 'my-own-folder')); // not ours: never touched
  backups.prune();
  const left = fs.readdirSync(folder).sort();
  assert.deepEqual(left, [
    'crm-backup-2026-01-01_1200-manual',
    'crm-backup-2026-03-05_0800-update', 'crm-backup-2026-04-05_0800-update', 'crm-backup-2026-05-05_0800-update', 'crm-backup-2026-06-05_0800-update', 'crm-backup-2026-07-05_0800-update',
    'crm-backup-2026-09-02_2300', // first of September (2 months kept: Oct and Sep)
    'crm-backup-2026-10-10_2300', // first of October, kept for the month
    'crm-backup-2026-10-11_2300', 'crm-backup-2026-10-12_2300', 'crm-backup-2026-10-13_2300', // the last 3 days (latest each day)
    'my-own-folder',
  ].sort());
});

test('a copy is made before the database is updated', () => {
  const file = path.join(dir, 'old', 'crm.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT); INSERT INTO contacts (first_name) VALUES ('Zoe');");
  fs.writeFileSync(path.join(dir, 'old', 'secret.key'), 'abc');
  const saved = backups.beforeUpdate(file, raw, 29);
  raw.close();
  assert.match(path.basename(saved), /^crm-backup-.*-update$/);
  assert.equal(path.dirname(saved), path.join(dir, 'old', 'backups'));
  const copy = new DatabaseSync(path.join(saved, 'crm.db'), { readOnly: true });
  assert.equal(copy.prepare('SELECT first_name FROM contacts').get().first_name, 'Zoe', 'includes changes still in the write-ahead log');
  copy.close();
  assert.equal(fs.readFileSync(path.join(saved, 'secret.key'), 'utf8'), 'abc');
  assert.equal(backups.beforeUpdate(file, null, 0), null, 'not for a brand-new database');
});

test('restoring a backup by upload: checked, swapped in, with a copy of what was there', async () => {
  const crypto = require('node:crypto');
  const keyHex = 'a'.repeat(64);
  // Something encrypted with this database's key, so the key check has work to do.
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([c.update('secret'), c.final()]);
  db.setSetting('test_encrypted', `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`);
  db.setSetting('backup_folder', path.join(dir, 'restore-test'));
  const made = await backups.run({ kind: 'manual' });
  db.insert('contacts', { first_name: 'Zed', last_name: 'After' });

  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) })).headers.get('set-cookie').split(';')[0];
  const put = (file, body) => fetch(`${srv.base}/backups/restore/${file}`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body });
  const apply = () => fetch(`${srv.base}/backups/restore/apply`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const backupDb = fs.readFileSync(path.join(made.folder, 'crm.db'));

  assert.equal((await put('crm.db', 'not a database')).status, 400);
  assert.equal((await put('notes.txt', 'x')).status, 404);
  assert.equal((await fetch(`${srv.base}/contacts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: '{}' })).status, 415, 'raw uploads only for restoring');

  // Without its key, or with the wrong one, it's refused.
  assert.equal((await put('crm.db', backupDb)).status, 200);
  let r = await apply();
  assert.equal(r.status, 400);
  assert.match(r.data.error, /needs its secret.key too/);
  assert.equal((await put('crm.db', backupDb)).status, 200);
  assert.equal((await put('secret.key', 'b'.repeat(64))).status, 200);
  r = await apply();
  assert.match(r.data.error, /doesn't belong to that database/);
  assert.ok(db.one("SELECT 1 FROM contacts WHERE first_name = 'Zed'"), 'nothing changed');

  assert.equal((await put('crm.db', backupDb)).status, 200);
  assert.equal((await put('secret.key', keyHex)).status, 200);
  r = await apply();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(db.one("SELECT 1 FROM contacts WHERE first_name = 'Zed'"), undefined, 'back to the backup');
  assert.ok(db.one("SELECT 1 FROM contacts WHERE first_name = 'Mia'"));
  assert.equal(r.data.contacts, db.one('SELECT COUNT(*) AS n FROM contacts').n);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'secret.key'), 'utf8'), keyHex);
  // What was there before is kept as a backup.
  const before = backups.list().find((b) => b.kind === 'update');
  const copy = new DatabaseSync(path.join(backups.settings().folder, before.name, 'crm.db'), { readOnly: true });
  assert.ok(copy.prepare("SELECT 1 FROM contacts WHERE first_name = 'Zed'").get());
  copy.close();
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'restore-staging')), 'uploads tidied away');
});

test('a Windows backup folder carried over to a Linux server falls back to the standard folder', () => {
  if (process.platform === 'win32') return;
  db.setSetting('backup_folder', 'C:\\Users\\sam\\OneDrive\\CRM Backups');
  const s = backups.settings();
  assert.equal(s.folder, path.join(dir, 'data', 'backups'));
  assert.equal(s.ignored_folder, 'C:\\Users\\sam\\OneDrive\\CRM Backups');
  assert.equal(s.custom_folder, false);
});
