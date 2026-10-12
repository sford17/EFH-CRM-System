'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

// Builds a valid w×h single-colour PNG.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${data.toString('base64')}`;
}

let srv;
let api;
let db;
before(async () => {
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => srv.close());

test('default theme until branding is saved', async () => {
  const css = await (await fetch(srv.base.replace('/api', '/brand.css'))).text();
  assert.match(css, /default theme/);
});

test('logo upload, colours and generated theme', async () => {
  assert.equal((await api.post('/branding/logo', { image: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const b = (await api.post('/branding/logo', { image: png(240, 80) })).data;
  assert.equal(b.logo.width, 240);
  assert.equal(b.logo.height, 80);
  const logo = await fetch(srv.base.replace('/api', b.logo.url));
  assert.equal(logo.headers.get('content-type'), 'image/png');

  assert.equal((await api.put('/branding', { primary: 'red' })).status, 400);
  // A very light brand colour is darkened so buttons and links stay readable.
  await api.put('/branding', { primary: '#ffd54f', sidebar: '#f5f5f5', email_style: 'branded' });
  const css = await (await fetch(srv.base.replace('/api', '/brand.css'))).text();
  const accent = css.match(/:root \{[^}]*--accent: (#[0-9a-f]{6})/)[1];
  const branding = require('../src/services/branding');
  assert.ok(branding.contrast(accent, '#ffffff') >= 4.5, `accent ${accent} readable on white`);
  assert.match(css, /--on-accent: #(ffffff|111111)/);
  assert.match(css, /--sidebar-strong: #111111/, 'dark text on a light sidebar');
  assert.match(css, /prefers-color-scheme: dark/);

  const status = (await srv.client().get('/auth/status')).data;
  assert.equal(status.brand.logo, b.logo.url, 'login page can show the logo');
});

test('only admins can change branding', async () => {
  await api.post('/users', { name: 'Brok', email: 'brok@test.local', password: 'password123', role: 'broker' });
  const broker = srv.client();
  await broker.login('brok@test.local', 'password123');
  assert.equal((await broker.put('/branding', { primary: '#000000' })).status, 403);
  assert.equal((await broker.get('/branding')).status, 200);
});

test('pasted signatures are cleaned and embedded images stored', async () => {
  const pasted = `<div style="font-family:Calibri"><b>Admin User</b> | Senior Broker<br>
    <img src="${png(120, 40)}" alt="logo">
    <img src="file:///C:/Users/admin/AppData/sig.png">
    <img src="cid:image001.png@01DA">
    <img src="https://cdn.example.com/badge.png" width="60">
    <a href="javascript:alert(1)">bad</a> <a href="https://efh.example">efh.example</a>
    <script>alert(1)</script><span style="background:url(https://x/y)" onclick="evil()">x</span></div>`;
  const r = (await api.put('/signature', { html: pasted })).data;
  assert.equal(r.removed_images, 2);
  assert.match(r.html, /<b>Admin User<\/b> \| Senior Broker/);
  assert.match(r.html, /<img src="\/assets\/\d+" alt="logo" \/>/);
  assert.match(r.html, /src="https:\/\/cdn\.example\.com\/badge\.png"/);
  assert.match(r.html, /href="https:\/\/efh\.example"/);
  assert.doesNotMatch(r.html, /script|javascript:|onclick|url\(|file:|cid:/);
  assert.match(r.html, /style="font-family:Calibri"/, 'safe inline styles kept');
  assert.equal((await api.get('/signature')).data.html, r.html);
});

test('emails are built with logo, colour and the sender\'s signature as inline images', () => {
  const { buildEmail } = require('../src/services/emailHtml');
  const user = db.one("SELECT id FROM users WHERE email = 'admin@test.local'");
  const e = buildEmail({ body: 'Hi Jane,\n\nSee https://efh.example/rates for details.\n\nKind regards,', senderUserId: user.id });
  assert.match(e.html, /border-top:5px solid #ffd54f/);
  assert.match(e.html, /<img src="cid:asset-\d+@efh-crm" width="\d+" height="\d+" alt="EFH Mortgage Broking"/, 'logo inline');
  assert.match(e.html, /<a href="https:\/\/efh\.example\/rates" style="color:#[0-9a-f]{6};">/);
  assert.match(e.html, /Senior Broker/);
  assert.equal(e.attachments.length, 2, 'logo + signature image');
  assert.ok(e.attachments.every((a) => a.data.length > 0 && a.cid && a.mime === 'image/png'));
  assert.match(e.text, /Hi Jane,\n\nSee https:\/\/efh\.example\/rates for details\.\n\nKind regards,\n\nAdmin User \| Senior Broker/);

  const escaped = buildEmail({ body: '<script>x</script> & co', senderUserId: user.id });
  assert.match(escaped.html, /&lt;script&gt;x&lt;\/script&gt; &amp; co/);

  const plain = buildEmail({ body: 'Thanks!', senderUserId: user.id, reply: true });
  assert.doesNotMatch(plain.html, /<table role="presentation"/, 'replies have no branded frame');
});

test('email preview is served sandboxed to its owner only', async () => {
  const t = db.one("SELECT id FROM email_templates WHERE name = 'Birthday'");
  const { url } = (await api.post('/email-preview', { template_id: t.id })).data;
  const res = await fetch(srv.base.replace('/api', url), { headers: { Cookie: await cookieFor(api) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /Hi Jane,/, 'sample client when none is chosen');
  assert.match(html, /happy birthday/i);
  assert.match(html, /src="\/assets\/\d+"/, 'preview uses image URLs, not cid:');
  const other = srv.client();
  await other.login('brok@test.local', 'password123');
  assert.equal((await other.get(url.replace('/api', ''))).status, 404);
});

// The test client keeps its cookie privately; log in again to read one.
async function cookieFor() {
  const res = await fetch(`${srv.base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}
