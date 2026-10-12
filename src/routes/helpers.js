'use strict';
const { HttpError } = require('../util');

// Copies whitelisted fields from a request body, turning '' into null.
function pick(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body && Object.prototype.hasOwnProperty.call(body, f)) {
      const v = body[f];
      out[f] = v === '' || v === undefined ? null : typeof v === 'boolean' ? Number(v) : v;
    }
  }
  return out;
}

function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj[f] === null || obj[f] === undefined || obj[f] === '');
  if (missing.length) throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);
}

function notFound(row, what = 'Record') {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
}

const intParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
};

// Only allow web links, so stored URLs can't run script when clicked.
function safeLink(row) {
  if (row.link && !/^https?:\/\//i.test(String(row.link))) throw new HttpError(400, 'Links must start with http:// or https://');
  return row;
}

const like = (q) => `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

module.exports = { pick, requireFields, notFound, intParam, like, safeLink };
