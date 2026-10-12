'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = require('./migrations');

let db;
let dbFile;

function open(file = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'crm.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  dbFile = file;
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate();
  return db;
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

// Path of the open database file, or ':memory:'.
const file = () => dbFile;

function get() {
  if (!db) open();
  return db;
}

function close() {
  if (db) db.close();
  db = undefined;
  txDepth = 0;
}

const all = (sql, ...params) => get().prepare(sql).all(...params);
const one = (sql, ...params) => get().prepare(sql).get(...params);
const run = (sql, ...params) => get().prepare(sql).run(...params);

function insert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return Number(run(sql, ...cols.map((c) => row[c])).lastInsertRowid);
}

function update(table, id, row) {
  const cols = Object.keys(row);
  if (!cols.length) return 0;
  const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  return Number(run(sql, ...cols.map((c) => row[c]), id).changes);
}

let txDepth = 0;

// Runs fn atomically. Nested calls use savepoints so services can be composed.
function transaction(fn) {
  const d = get();
  const sp = `sp_${txDepth}`;
  d.exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    d.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    d.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

function getSetting(key, fallback = null) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

module.exports = { open, get, close, file, all, one, run, insert, update, transaction, getSetting, setSetting };
