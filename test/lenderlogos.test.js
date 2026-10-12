'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

function pngBuffer(w, h, rgb = [200, 30, 40]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

// Fake icon service: westpac.com.au has a real icon, unknown.example only the tiny globe.
const iconServer = http.createServer((req, res) => {
  const domain = new URL(req.url, 'http://x').searchParams.get('domain');
  const img = domain === 'unknown.example' ? pngBuffer(16, 16) : pngBuffer(128, 128, [204, 0, 0]);
  res.writeHead(domain === 'unknown.example' ? 404 : 200, { 'Content-Type': 'image/png' });
  res.end(img);
});

let srv;
let api;
let db;
const lenderId = (name) => db.one('SELECT id FROM lenders WHERE name = ?', name).id;

before(async () => {
  await new Promise((r) => iconServer.listen(0, '127.0.0.1', r));
  process.env.LOGO_FETCH_URL = `http://127.0.0.1:${iconServer.address().port}/s2/favicons`;
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(async () => { await srv.close(); iconServer.close(); });

test('upload, fetch from website, and remove lender logos', async () => {
  assert.equal(db.one("SELECT website FROM lenders WHERE name = 'Westpac'").website, 'westpac.com.au', 'default lenders come with websites');
  assert.equal((await api.post(`/lenders/${lenderId('NAB')}/logo`, { image: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  const up = (await api.post(`/lenders/${lenderId('NAB')}/logo`, { image: dataUri(pngBuffer(240, 80)) })).data;
  assert.ok(up.logo_asset_id);
  const fetched = (await api.post(`/lenders/${lenderId('Westpac')}/logo/fetch`)).data;
  assert.ok(fetched.logo_asset_id);
  assert.equal(db.one('SELECT width FROM assets WHERE id = ?', fetched.logo_asset_id).width, 128);

  await api.patch(`/lenders/${lenderId('ING')}`, { website: 'https://www.unknown.example/home' });
  const tiny = await api.post(`/lenders/${lenderId('ING')}/logo/fetch`);
  assert.equal(tiny.status, 502);
  assert.match(tiny.data.error, /No logo found for unknown\.example|tiny icon/);
  const custom = (await api.post('/lenders', { name: 'Credit Union Co' })).data;
  assert.equal((await api.post(`/lenders/${custom.id}/logo/fetch`)).status, 400, 'needs a website');

  const lenders = (await api.get('/lenders')).data.rows;
  assert.ok(lenders.find((l) => l.name === 'NAB').logo_asset_id);
  // Logos are served publicly, like the business logo (they appear in emails).
  const img = await fetch(srv.base.replace('/api', `/assets/${up.logo_asset_id}`));
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('deals and the tracker carry the lender logo', async () => {
  const c = (await api.post('/contacts', { first_name: 'Lou', last_name: 'Logo', email: 'lou@example.com', status: 'client' })).data;
  const deal = (await api.post('/deals', { contact_id: c.id, lender_id: lenderId('Westpac'), loan_amount: 500000, property_address: '1 Logo Lane', property_value: 800000,
    rate_type: 'fixed', fixed_expiry_date: require('../src/util').addDays(require('../src/util').today(), 30) })).data;
  assert.ok(deal.lender_logo_id);
  const pipeline = (await api.get('/deals/pipeline')).data.stages.flatMap((s) => s.deals);
  assert.ok(pipeline.find((d) => d.id === deal.id).lender_logo_id);
  assert.ok((await api.get(`/contacts/${c.id}`)).data.deals[0].lender_logo_id);
  await api.post(`/deals/${deal.id}/stage`, { stage: 'settled', settlement_date: '2024-01-01' });
  const s = (await api.get(`/tracker/contacts/${c.id}`)).data;
  assert.ok(s.loans[0].lender_logo_id);
  assert.ok(s.structure.lenders[0].logo_id);
});

test('lender names are found in text without false matches', () => {
  const { mentionedIn } = require('../src/services/lenderLogos');
  const names = (t) => mentionedIn(t).map((l) => l.name);
  assert.deepEqual(names('Your fixed rate with Westpac ends soon.'), ['Westpac']);
  assert.deepEqual(names('your loan with westpac'), ['Westpac'], 'longer names match any case');
  assert.deepEqual(names('Thanks for booking a time and banking with us.'), [], '"ing"/"nab" inside words never match');
  assert.deepEqual(names('Compare NAB and Westpac offers'), ['NAB', 'Westpac'], 'in order of mention');
  assert.deepEqual(names('nab is lowercase here'), [], 'short names need capitals');
});

test('emails show the logos of lenders they mention', () => {
  const { buildEmail } = require('../src/services/emailHtml');
  const user = db.one("SELECT id FROM users WHERE email = 'admin@test.local'").id;
  const nabAsset = db.one("SELECT logo_asset_id FROM lenders WHERE name = 'NAB'").logo_asset_id;
  const e = buildEmail({ body: 'Hi Lou,\n\nNAB has approved your loan.\n\nKind regards,', senderUserId: user });
  assert.match(e.html, new RegExp(`<img src="cid:asset-${nabAsset}@efh-crm"[^>]*alt="NAB"`));
  assert.ok(e.attachments.some((a) => a.cid === `asset-${nabAsset}@efh-crm`));
  const none = buildEmail({ body: 'Hi Lou, just checking in.', senderUserId: user });
  assert.doesNotMatch(none.html, /alt="NAB"/);
  const reply = buildEmail({ body: 'Thanks – NAB is fine.', senderUserId: user, reply: true });
  assert.doesNotMatch(reply.html, /alt="NAB"/, 'replies stay plain');
  db.setSetting('brand_email_style', 'plain');
  const plain = buildEmail({ body: 'NAB update', senderUserId: user });
  assert.match(plain.html, /alt="NAB"[^>]*>.*<div class="signature"/s, 'plain style shows logos above the signature');
  db.setSetting('brand_email_style', 'branded');
});

test('fixed-rate reminder emails carry the lender logo', async () => {
  await api.post('/automations/run-scheduled');
  await api.post('/outbox/process');
  const mail = db.one("SELECT body FROM outbox WHERE subject LIKE 'Your fixed rate ends on%' AND to_email = 'lou@example.com'");
  assert.match(mail.body, /Your fixed rate with Westpac ends on/);
  const { buildEmail } = require('../src/services/emailHtml');
  assert.match(buildEmail({ body: mail.body }).html, /alt="Westpac"/);
});

test('lending review documents show lender logos', async () => {
  const c = db.one("SELECT id FROM contacts WHERE email = 'lou@example.com'");
  const r = (await api.post('/reviews', { contact_id: c.id })).data;
  const cookie = (await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'password123' }) }))
    .headers.get('set-cookie').split(';')[0];
  const get = async (p) => Buffer.from(await (await fetch(`${srv.base}/reviews/${r.id}/${p}`, { headers: { Cookie: cookie } })).arrayBuffer());
  const html = (await get('preview')).toString();
  assert.match(html, /<img class="lender-logo" src="\/assets\/\d+"/);
  assert.match(html, /<image [^>]*href="data:image\/png;base64,/, 'diagram lender header');
  const pdf = (await get('pdf')).toString('latin1');
  assert.ok((pdf.match(/\/Subtype \/Image/g) || []).length >= 1, 'PDF embeds the lender logo');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await get('docx'));
  assert.ok(Object.keys(zip.files).some((f) => f.startsWith('word/media/')), 'Word file embeds the lender logo');
});

test('templates sent by hand fill loan fields from the client\'s tracker', async () => {
  const c = db.one("SELECT id FROM contacts WHERE email = 'lou@example.com'");
  const t = db.one("SELECT id FROM email_templates WHERE name = 'Fixed rate expiry review'");
  const p = (await api.post(`/templates/${t.id}/preview`, { contact_id: c.id })).data;
  assert.match(p.subject, /^Your fixed rate ends on \d+ \w+ \d{4}$/);
  assert.match(p.body, /Your fixed rate with Westpac ends on \d+ \w+ \d{4}\./);
});
