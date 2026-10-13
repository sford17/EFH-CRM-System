'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// A tiny PNG (2x2) and a wide one (4x1) for the Instagram ratio check.
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const seen = [];
let liFail = false;
let igStatus = 'FINISHED';
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://x');
  const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw.toString() || '{}')
    : Object.fromEntries(new URLSearchParams(raw.toString()));
  seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers, bytes: raw.length });
  const json = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
  const p = url.pathname;
  // LinkedIn
  if (p === '/li/oauth/accessToken') return json(200, { access_token: 'li-token', expires_in: 5184000 });
  if (p === '/li/api/v2/userinfo') return json(200, { sub: 'abc123', name: 'Sam Ford', picture: 'https://media.licdn.com/sam.jpg' });
  if (p === '/li/api/rest/images') return json(200, { value: { uploadUrl: `http://127.0.0.1:${fake.address().port}/li/upload/1`, image: 'urn:li:image:IMG1' } });
  if (p === '/li/upload/1') { res.writeHead(201); return res.end(); }
  if (p === '/li/api/rest/posts') {
    if (liFail) return json(401, { message: 'Invalid access token', serviceErrorCode: 65601 });
    res.writeHead(201, { 'x-restli-id': 'urn:li:share:777' });
    return res.end();
  }
  // Instagram
  if (p === '/ig/api/oauth/access_token') return json(200, { data: [{ access_token: 'ig-short', user_id: '1789', permissions: 'instagram_business_basic' }] });
  if (p === '/ig/graph/access_token') return json(200, { access_token: 'ig-long', token_type: 'bearer', expires_in: 5183944 });
  if (p === '/ig/graph/refresh_access_token') return json(200, { access_token: 'ig-refreshed', token_type: 'bearer', expires_in: 5184000 });
  if (p === '/ig/graph/v23.0/me') return json(200, { user_id: '1789', username: 'efh.finance', account_type: 'BUSINESS', profile_picture_url: 'https://cdn.ig/p.jpg' });
  if (p === '/ig/graph/v23.0/1789/media') return json(200, { id: 'C1' });
  if (p === '/ig/graph/v23.0/C1') return json(200, { status_code: igStatus });
  if (p === '/ig/graph/v23.0/1789/media_publish') return json(200, { id: 'M9' });
  if (p === '/ig/graph/v23.0/M9') return json(200, { permalink: 'https://www.instagram.com/p/XYZ/' });
  // Pictures on "the internet"
  if (p === '/pics/square.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png(2, 2)); }
  if (p === '/pics/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html></html>'); }
  return json(404, { error: { message: `no route ${p}` } });
});

let srv;
let api;
let db;
let base;
before(async () => {
  await new Promise((r) => { fake.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    LINKEDIN_AUTH_URL: `${base}/li/oauth`, LINKEDIN_API_URL: `${base}/li/api`,
    INSTAGRAM_AUTH_URL: `${base}/ig/authorize`, INSTAGRAM_API_URL: `${base}/ig/api`, INSTAGRAM_GRAPH_URL: `${base}/ig/graph`,
    SOCIAL_ALLOW_PRIVATE_URLS: '1', SOCIAL_POLL_MS: '0',
  });
  ({ db } = require('./helpers'));
  srv = await require('./helpers').startServer();
  api = srv.client();
  await api.login();
});
after(() => { srv.close(); fake.close(); });

const lastTo = (path) => [...seen].reverse().find((s) => s.path === path);

test('LinkedIn text keeps hashtags and escapes markup', () => {
  const { linkedinText } = require('../src/services/social');
  assert.equal(linkedinText('Rates (finally) down! #homeloans #FirstHome @me'), 'Rates \\(finally\\) down! {hashtag|\\#|homeloans} {hashtag|\\#|FirstHome} \\@me');
});

test('connecting needs the app set up first', async () => {
  const r = await api.post('/social/connect/linkedin');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /hasn't been set up yet/);
  assert.equal((await api.post('/social/connect/myspace')).status, 404);
  await api.put('/social/config', { linkedin_client_id: 'li-client', linkedin_client_secret: 'li-secret', instagram_app_id: 'ig-app', instagram_app_secret: 'ig-secret' });
  const s = (await api.get('/social/status')).data;
  assert.deepEqual(s.networks.map((n) => [n.key, n.configured, n.account]), [['linkedin', true, null], ['instagram', true, null]]);
  assert.equal(s.app.has_linkedin_secret, true);
  assert.notEqual(db.getSetting('social_linkedin_client_secret'), 'li-secret', 'secret stored encrypted');
});

test('connect LinkedIn through sign-in', async () => {
  const { url } = (await api.post('/social/connect/linkedin')).data;
  const u = new URL(url);
  assert.equal(u.pathname, '/li/oauth/authorization');
  assert.equal(u.searchParams.get('scope'), 'openid profile w_member_social');
  assert.match(u.searchParams.get('redirect_uri'), /\/api\/social\/callback\/linkedin$/);
  const page = await fetch(`${srv.base}/social/callback/linkedin?code=abc&state=${u.searchParams.get('state')}`);
  assert.match(await page.text(), /Sam Ford is connected/);
  assert.equal(lastTo('/li/oauth/accessToken').body.client_secret, 'li-secret');
  const again = await fetch(`${srv.base}/social/callback/linkedin?code=abc&state=${u.searchParams.get('state')}`);
  assert.match(await again.text(), /expired/, 'state used once');
  const acct = (await api.get('/social/status')).data.networks[0].account;
  assert.equal(acct.name, 'Sam Ford');
  assert.equal(acct.expired, false);
});

test('Instagram sign-in needs an https address; the token route works anywhere', async () => {
  const r = await api.post('/social/connect/instagram');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /https/);
  assert.equal((await api.post('/social/instagram/token', { token: 'short' })).status, 400);
  const ok = await api.post('/social/instagram/token', { token: 'IGAAtokenfromthedashboard123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.username, 'efh.finance');
  assert.equal(lastTo('/ig/graph/refresh_access_token').query.access_token, 'IGAAtokenfromthedashboard123');
});

test('Instagram sign-in once the CRM has an https address', async () => {
  await api.put('/settings', { app_url: 'https://crm.efh.com.au' });
  const { url } = (await api.post('/social/connect/instagram')).data;
  const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://crm.efh.com.au/api/social/callback/instagram');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic,instagram_business_content_publish');
  const page = await fetch(`${srv.base}/social/callback/instagram?code=xyz&state=${u.searchParams.get('state')}`);
  assert.match(await page.text(), /@efh\.finance is connected/);
  assert.equal(lastTo('/ig/graph/access_token').query.grant_type, 'ig_exchange_token');
  await api.put('/settings', { app_url: '' });
});

let square;
test('pictures: upload or link, JPG/PNG only', async () => {
  square = (await api.post('/social/images', { image: dataUri(png(2, 2)) })).data;
  assert.equal(square.width, 2);
  assert.equal((await api.post('/social/images', { image: 'data:image/gif;base64,R0lGOD' })).status, 400);
  const linked = await api.post('/social/images', { url: `${base}/pics/square.png` });
  assert.equal(linked.status, 201);
  assert.match((await api.post('/social/images', { url: `${base}/pics/page` })).data.error, /web page, not a picture/);
  assert.match((await api.post('/social/images', { url: 'ftp://example.com/a.png' })).data.error, /https/);
});

test('post to LinkedIn now, with a picture', async () => {
  const r = await api.post('/social/posts', { body: 'New rates this week! #homeloans', image_asset_id: square.id, alt_text: 'Chart', networks: ['linkedin'], action: 'now' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'posted');
  assert.deepEqual(r.data.targets.map((t) => [t.network, t.status, t.url]), [['linkedin', 'posted', 'https://www.linkedin.com/feed/update/urn:li:share:777/']]);
  const post = lastTo('/li/api/rest/posts');
  assert.equal(post.body.author, 'urn:li:person:abc123');
  assert.equal(post.body.commentary, 'New rates this week! {hashtag|\\#|homeloans}');
  assert.deepEqual(post.body.content, { media: { id: 'urn:li:image:IMG1', altText: 'Chart' } });
  assert.equal(post.headers['x-restli-protocol-version'], '2.0.0');
  assert.match(post.headers['linkedin-version'], /^\d{6}$/);
  assert.ok(lastTo('/li/upload/1').bytes > 0, 'picture bytes uploaded');
});

test('Instagram rules: picture needed, ratio, caption limits, public picture', async () => {
  const noPic = await api.post('/social/posts', { body: 'Hi', networks: ['instagram'], action: 'now' });
  assert.match(noPic.data.error, /need a picture/);
  const wide = (await api.post('/social/images', { image: dataUri(png(4, 1)) })).data;
  assert.match((await api.post('/social/posts', { body: 'x', image_asset_id: wide.id, networks: ['instagram'], action: 'now' })).data.error, /4:5 and landscape 1\.91:1/);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.match((await api.post('/social/posts', { body: tags, image_asset_id: square.id, image_url: `${base}/pics/square.png`, networks: ['instagram'], action: 'now' })).data.error, /30 hashtags/);
  // An uploaded picture can't be fetched by Instagram while the CRM is on localhost.
  assert.match((await api.post('/social/posts', { body: 'x', image_asset_id: square.id, networks: ['instagram'], action: 'now' })).data.error, /public web address/);
  assert.match((await api.post('/social/posts', { body: 'x'.repeat(3001), networks: ['linkedin'], action: 'now' })).data.error, /3,000 characters/);
});

test('post to both now: Instagram gets the picture link', async () => {
  const r = await api.post('/social/posts', {
    body: 'Settled another first home this week! #firsthome', image_asset_id: square.id, image_url: `${base}/pics/square.png`, networks: ['linkedin', 'instagram'], action: 'now',
  });
  assert.equal(r.data.status, 'posted');
  const ig = r.data.targets.find((t) => t.network === 'instagram');
  assert.equal(ig.url, 'https://www.instagram.com/p/XYZ/');
  const create = lastTo('/ig/graph/v23.0/1789/media');
  assert.equal(create.body.image_url, `${base}/pics/square.png`);
  assert.equal(create.body.caption, 'Settled another first home this week! #firsthome');
  assert.equal(lastTo('/ig/graph/v23.0/1789/media_publish').body.creation_id, 'C1');
});

test('with a public https address, uploaded pictures are served for Instagram', async () => {
  await api.put('/settings', { app_url: 'https://crm.efh.com.au' });
  const r = await api.post('/social/posts', { body: 'Hello', image_asset_id: square.id, networks: ['instagram'], action: 'now' });
  assert.equal(r.data.status, 'posted');
  const link = lastTo('/ig/graph/v23.0/1789/media').body.image_url;
  assert.match(link, /^https:\/\/crm\.efh\.com\.au\/api\/social\/media\/[\w-]+\.png$/);
  const pic = await fetch(`${srv.base}/social/media/${link.split('/').pop()}`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${srv.base}/social/media/nope1234567890123456.png`)).status, 404);
  await api.put('/settings', { app_url: '' });
});

test('drafts, scheduling, the scheduler and failures', async () => {
  const draft = (await api.post('/social/posts', { body: 'Idea for later', networks: ['linkedin'] })).data;
  assert.equal(draft.status, 'draft');
  assert.equal((await api.post('/social/posts', { body: 'x', networks: ['linkedin'], action: 'schedule', scheduled_at: '2020-01-01T00:00:00Z' })).status, 400);
  const later = new Date(Date.now() + 3600000).toISOString();
  const sched = (await api.put(`/social/posts/${draft.id}`, { body: 'Tuesday tip', networks: ['linkedin'], action: 'schedule', scheduled_at: later })).data;
  assert.equal(sched.status, 'scheduled');
  const social = require('../src/services/social');
  assert.equal(await social.publishDue(), 0, 'not due yet');
  db.run('UPDATE social_posts SET scheduled_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), draft.id);
  assert.equal(await social.publishDue(), 1);
  assert.equal(social.getPost(draft.id).status, 'posted');
  assert.equal((await api.put(`/social/posts/${draft.id}`, { body: 'edit' })).status, 400, 'posted posts are locked');

  liFail = true;
  const bad = (await api.post('/social/posts', { body: 'Will fail', networks: ['linkedin'], action: 'now' })).data;
  assert.equal(bad.status, 'failed');
  assert.match(bad.targets[0].error, /LinkedIn: Invalid access token.*Reconnect/);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'Social post failed: LinkedIn%'"));
  liFail = false;
  const retried = (await api.post(`/social/posts/${bad.id}/retry`)).data;
  assert.equal(retried.status, 'posted');

  // Instagram still processing: left for the next run.
  igStatus = 'IN_PROGRESS';
  const slow = (await api.post('/social/posts', { body: 'Slow', image_asset_id: square.id, image_url: `${base}/pics/square.png`, networks: ['instagram'], action: 'now' })).data;
  assert.equal(slow.status, 'publishing');
  igStatus = 'FINISHED';
  await social.publishDue();
  assert.equal(social.getPost(slow.id).status, 'posted');

  const list = (await api.get('/social/posts?status=posted')).data.rows;
  assert.ok(list.length >= 5);
  assert.equal((await api.del(`/social/posts/${bad.id}`)).status, 200);
});

test('tokens: Instagram refreshed before expiry, LinkedIn reminder to reconnect', async () => {
  const social = require('../src/services/social');
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const old = new Date(Date.now() - 50 * 86400000).toISOString();
  db.run('UPDATE social_accounts SET expires_at = ?, refreshed_at = ?', soon, old);
  assert.equal(await social.refreshTokens(), 1, 'Instagram refreshed');
  const ig = db.one("SELECT expires_at FROM social_accounts WHERE network = 'instagram'");
  assert.ok(Date.parse(ig.expires_at) > Date.now() + 50 * 86400000);
  assert.ok(db.one("SELECT 1 FROM notifications WHERE message LIKE 'Your LinkedIn connection expires on%'"));
  await social.refreshTokens();
  assert.equal(db.one("SELECT COUNT(*) AS n FROM notifications WHERE message LIKE 'Your LinkedIn connection%'").n, 1, 'reminded once');
  assert.equal((await api.post('/social/disconnect/linkedin')).status, 200);
  assert.equal((await api.get('/social/status')).data.networks[0].account, null);
});
