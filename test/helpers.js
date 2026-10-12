'use strict';
process.env.DB_FILE = ':memory:';
process.env.SCHEDULER = 'off';

const db = require('../src/db');
const { createApp } = require('../src/app');
const { seedDefaults } = require('../src/db/seed');
const auth = require('../src/auth');

// Starts a fresh in-memory CRM with one admin user and returns a small client.
async function startServer() {
  db.close();
  db.open(':memory:');
  seedDefaults();
  db.insert('users', { name: 'Admin User', email: 'admin@test.local', password_hash: auth.hashPassword('password123'), role: 'admin', phone: '0400 111 222' });
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const client = (cookie = '') => {
    const request = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
    return {
      get: (p) => request('GET', p),
      post: (p, b = {}, h) => request('POST', p, b, h),
      patch: (p, b) => request('PATCH', p, b),
      put: (p, b) => request('PUT', p, b),
      del: (p) => request('DELETE', p),
      raw: request,
      async login(email = 'admin@test.local', password = 'password123') {
        const r = await request('POST', '/auth/login', { email, password });
        if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
        return r.data.user;
      },
    };
  };

  return { server, base, client, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startServer, db };
