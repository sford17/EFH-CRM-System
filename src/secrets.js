'use strict';
// Encrypts sensitive values (Outlook tokens, the app's client secret) before
// they are stored. The key comes from ENCRYPTION_KEY, or is generated once and
// kept in secret.key next to the database file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

let key;

function getKey() {
  if (key) return key;
  if (process.env.ENCRYPTION_KEY) {
    key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
    return key;
  }
  const dbFile = db.file();
  if (!dbFile || dbFile === ':memory:') {
    key = crypto.randomBytes(32);
    return key;
  }
  const keyFile = path.join(path.dirname(dbFile), 'secret.key');
  if (fs.existsSync(keyFile)) {
    key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

function encrypt(text) {
  if (text === null || text === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function decrypt(value) {
  if (!value) return null;
  const [version, iv, tag, data] = String(value).split(':');
  if (version !== 'v1') throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// For tests that reopen a fresh database.
function resetKey() {
  key = undefined;
}

module.exports = { encrypt, decrypt, resetKey };
