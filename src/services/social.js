'use strict';
// Social posting: each broker connects their own LinkedIn profile and
// Instagram professional account, then posts (now or scheduled) from the CRM.
//
// LinkedIn: "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn"
// products (scopes openid profile w_member_social). Posts go through the
// versioned Posts API; images are uploaded through the Images API.
// Instagram: "Instagram API with Instagram Login" (Business Login), scopes
// instagram_business_basic + instagram_business_content_publish. Instagram
// fetches the picture itself, so it must be at a public https address.
const crypto = require('node:crypto');
const net = require('node:net');
const db = require('../db');
const { encrypt, decrypt } = require('../secrets');
const { nowIso, HttpError } = require('../util');
const branding = require('./branding');

const NETWORKS = { linkedin: 'LinkedIn', instagram: 'Instagram' };
const LIMITS = { linkedin: 3000, instagram: 2200, instagram_hashtags: 30, instagram_mentions: 20 };
const MAX_IMAGE = 8 * 1024 * 1024;
const LINKEDIN_SCOPES = 'openid profile w_member_social';
const INSTAGRAM_SCOPES = 'instagram_business_basic,instagram_business_content_publish';
const IG_VERSION = 'v23.0';

const env = (k, d) => (process.env[k] || d).replace(/\/$/, '');
const liAuth = () => env('LINKEDIN_AUTH_URL', 'https://www.linkedin.com/oauth/v2');
const liApi = () => env('LINKEDIN_API_URL', 'https://api.linkedin.com');
const liVersion = () => process.env.LINKEDIN_VERSION || db.getSetting('linkedin_api_version', '') || '202608';
const igAuth = () => env('INSTAGRAM_AUTH_URL', 'https://www.instagram.com/oauth/authorize');
const igApi = () => env('INSTAGRAM_API_URL', 'https://api.instagram.com');
const igGraph = () => env('INSTAGRAM_GRAPH_URL', 'https://graph.instagram.com');
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const days = (n) => n * 86400000;

// Errors from LinkedIn/Instagram: shown to the broker, never as a 401 (which
// would sign them out of the CRM).
class SocialError extends Error {}

// ---- App settings (admin) ------------------------------------------------------

function secret(key) {
  try {
    return decrypt(db.getSetting(key, '')) || null;
  } catch {
    return null; // encryption key changed; re-enter the secret
  }
}

function appConfig() {
  return {
    linkedin: { clientId: db.getSetting('social_linkedin_client_id', '') || '', clientSecret: secret('social_linkedin_client_secret') },
    instagram: { clientId: db.getSetting('social_instagram_app_id', '') || '', clientSecret: secret('social_instagram_app_secret') },
  };
}

function saveAppConfig(body = {}) {
  const set = (key, v) => { if (v !== undefined) db.setSetting(key, String(v || '').trim()); };
  set('social_linkedin_client_id', body.linkedin_client_id);
  set('social_instagram_app_id', body.instagram_app_id);
  if (body.linkedin_client_secret) db.setSetting('social_linkedin_client_secret', encrypt(String(body.linkedin_client_secret).trim()));
  if (body.instagram_app_secret) db.setSetting('social_instagram_app_secret', encrypt(String(body.instagram_app_secret).trim()));
}

const configured = (network) => {
  const c = appConfig()[network];
  return Boolean(c.clientId && c.clientSecret);
};

// The CRM's own address, as the outside world sees it (Settings → CRM web address).
function publicBase() {
  const base = (process.env.APP_URL || db.getSetting('app_url', '') || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return null;
  const host = new URL(base).hostname;
  return host === 'localhost' || host.endsWith('.local') || net.isIP(host) ? null : base;
}

// ---- HTTP helpers ----------------------------------------------------------------

async function call(url, { method = 'GET', headers = {}, body, form, json } = {}, label = 'LinkedIn') {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(json ? { 'Content-Type': 'application/json' } : form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
      body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : body,
    });
  } catch (err) {
    throw new SocialError(`Couldn't reach ${label} (${err.cause?.code || err.message}). Check the internet connection and try again.`);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.error?.message || data.error_description || data.error_message || data.message || (typeof data.error === 'string' ? data.error : null) || `${label} returned an error (${res.status})`;
    const err = new SocialError(`${label}: ${msg}`);
    err.status = res.status;
    err.expired = res.status === 401 || data.error?.code === 190 || data.code === 'EXPIRED_ACCESS_TOKEN';
    throw err;
  }
  return { data, headers: res.headers };
}

// ---- Connecting ---------------------------------------------------------------------

function redirectUri(network, requestBase) {
  return `${publicBase() || requestBase}/api/social/callback/${network}`;
}

function startConnect(network, userId, requestBase) {
  if (!Object.hasOwn(NETWORKS, network)) throw new HttpError(404, 'Unknown network');
  const cfg = appConfig()[network];
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new HttpError(400, `${NETWORKS[network]} hasn't been set up yet. An admin needs to enter the app details under "Set up" on the Social page first.`);
  }
  const uri = redirectUri(network, requestBase);
  if (network === 'instagram' && !/^https:/i.test(uri)) {
    throw new HttpError(400, 'Instagram only signs in to https web addresses. Set the CRM web address (Settings → Business) to your https address, or connect with an access token instead.');
  }
  const state = randomToken(24);
  db.run('DELETE FROM oauth_states WHERE expires_at < ?', nowIso());
  db.insert('oauth_states', { state, user_id: userId, verifier: `social:${network}`, redirect_uri: uri, expires_at: new Date(Date.now() + 10 * 60000).toISOString() });
  const params = network === 'linkedin'
    ? { response_type: 'code', client_id: cfg.clientId, redirect_uri: uri, state, scope: LINKEDIN_SCOPES }
    : { client_id: cfg.clientId, redirect_uri: uri, response_type: 'code', scope: INSTAGRAM_SCOPES, state, enable_fb_login: '0', force_authentication: '1' };
  return network === 'linkedin' ? `${liAuth()}/authorization?${new URLSearchParams(params)}` : `${igAuth()}?${new URLSearchParams(params)}`;
}

function saveAccount(userId, network, fields) {
  const row = {
    external_id: String(fields.external_id),
    name: fields.name || null,
    username: fields.username || null,
    picture_url: fields.picture_url && /^https:\/\//.test(fields.picture_url) ? fields.picture_url : null,
    access_token: encrypt(fields.access_token),
    refresh_token: fields.refresh_token ? encrypt(fields.refresh_token) : null,
    expires_at: fields.expires_in ? new Date(Date.now() + Number(fields.expires_in) * 1000).toISOString() : null,
    connected_at: nowIso(),
    refreshed_at: nowIso(),
    expiry_warned_at: null,
    last_error: null,
  };
  const existing = db.one('SELECT id FROM social_accounts WHERE user_id = ? AND network = ?', userId, network);
  if (existing) db.update('social_accounts', existing.id, row);
  else db.insert('social_accounts', { user_id: userId, network, ...row });
  return db.one('SELECT * FROM social_accounts WHERE user_id = ? AND network = ?', userId, network);
}

async function linkedinProfile(token) {
  const { data } = await call(`${liApi()}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  if (!data.sub) throw new SocialError('LinkedIn didn\'t say whose account this is. Make sure the app has "Sign In with LinkedIn using OpenID Connect".');
  return { external_id: data.sub, name: data.name || [data.given_name, data.family_name].filter(Boolean).join(' '), picture_url: data.picture };
}

async function instagramProfile(token) {
  const { data } = await call(`${igGraph()}/${IG_VERSION}/me?${new URLSearchParams({ fields: 'user_id,username,name,profile_picture_url,account_type', access_token: token })}`, {}, 'Instagram');
  if (data.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(String(data.account_type).toUpperCase())) {
    throw new SocialError('Instagram only lets professional (Business or Creator) accounts post through other apps. Switch the account to a professional account in the Instagram app, then connect again.');
  }
  return { external_id: data.user_id || data.id, name: data.name, username: data.username, picture_url: data.profile_picture_url };
}

async function finishConnect(network, { code, state }) {
  const row = state ? db.one('SELECT * FROM oauth_states WHERE state = ?', state) : null;
  if (!row || row.expires_at < nowIso() || row.verifier !== `social:${network}`) {
    throw new SocialError(`This sign-in link has expired. Go back to the Social page and click "Connect ${NETWORKS[network]}" again.`);
  }
  db.run('DELETE FROM oauth_states WHERE state = ?', state);
  const cfg = appConfig()[network];
  if (network === 'linkedin') {
    const { data: t } = await call(`${liAuth()}/accessToken`, {
      method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri, client_id: cfg.clientId, client_secret: cfg.clientSecret },
    });
    const profile = await linkedinProfile(t.access_token);
    return { userId: row.user_id, account: saveAccount(row.user_id, 'linkedin', { ...profile, access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in }) };
  }
  // Instagram: short-lived token, then a 60-day token.
  const { data: short } = await call(`${igApi()}/oauth/access_token`, {
    method: 'POST', form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', redirect_uri: row.redirect_uri, code },
  }, 'Instagram');
  const shortToken = short.access_token || short.data?.[0]?.access_token;
  const { data: long } = await call(`${igGraph()}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: cfg.clientSecret, access_token: shortToken })}`, {}, 'Instagram');
  const profile = await instagramProfile(long.access_token);
  return { userId: row.user_id, account: saveAccount(row.user_id, 'instagram', { ...profile, access_token: long.access_token, expires_in: long.expires_in }) };
}

// For CRMs without an https address: a token generated in the Meta App
// Dashboard (Instagram → API setup → Generate token).
async function connectInstagramToken(userId, token) {
  const t = String(token || '').trim();
  if (t.length < 20 || /\s/.test(t)) throw new HttpError(400, 'Paste the whole access token from the Meta App Dashboard');
  let profile;
  try {
    profile = await instagramProfile(t);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  // Dashboard tokens are long-lived (60 days); refresh now to learn the expiry.
  let expiresIn = 60 * 86400;
  let access = t;
  try {
    const { data } = await call(`${igGraph()}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: t })}`, {}, 'Instagram');
    if (data.access_token) { access = data.access_token; expiresIn = data.expires_in || expiresIn; }
  } catch { /* not refreshable yet (under 24 hours old): keep the default */ }
  return saveAccount(userId, 'instagram', { ...profile, access_token: access, expires_in: expiresIn });
}

function disconnect(userId, network) {
  db.run('DELETE FROM social_accounts WHERE user_id = ? AND network = ?', userId, network);
}

function publicAccount(a) {
  if (!a) return null;
  const expiresSoon = a.expires_at && Date.parse(a.expires_at) - Date.now() < days(7);
  return {
    network: a.network, name: a.name, username: a.username, picture_url: a.picture_url, connected_at: a.connected_at,
    expires_at: a.expires_at, expired: Boolean(a.expires_at && a.expires_at < nowIso()), expires_soon: Boolean(expiresSoon), last_error: a.last_error,
  };
}

const accountFor = (userId, network) => db.one('SELECT * FROM social_accounts WHERE user_id = ? AND network = ?', userId, network);

// ---- Keeping tokens alive (scheduler) ----------------------------------------------

async function refreshTokens(log = console) {
  let refreshed = 0;
  const now = Date.now();
  for (const a of db.all('SELECT * FROM social_accounts WHERE expires_at IS NOT NULL')) {
    const left = Date.parse(a.expires_at) - now;
    try {
      if (a.network === 'instagram' && left > 0 && left < days(20) && now - Date.parse(a.refreshed_at || a.connected_at) > days(1)) {
        const { data } = await call(`${igGraph()}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: decrypt(a.access_token) })}`, {}, 'Instagram');
        db.update('social_accounts', a.id, {
          access_token: encrypt(data.access_token), expires_at: new Date(now + Number(data.expires_in || 5184000) * 1000).toISOString(), refreshed_at: nowIso(), last_error: null,
        });
        refreshed += 1;
      } else if (a.network === 'linkedin' && a.refresh_token && left < days(10)) {
        const cfg = appConfig().linkedin;
        const { data } = await call(`${liAuth()}/accessToken`, {
          method: 'POST', form: { grant_type: 'refresh_token', refresh_token: decrypt(a.refresh_token), client_id: cfg.clientId, client_secret: cfg.clientSecret },
        });
        db.update('social_accounts', a.id, {
          access_token: encrypt(data.access_token), refresh_token: data.refresh_token ? encrypt(data.refresh_token) : a.refresh_token,
          expires_at: new Date(now + Number(data.expires_in || 5184000) * 1000).toISOString(), refreshed_at: nowIso(), last_error: null,
        });
        refreshed += 1;
      } else if (left < days(7) && !a.expiry_warned_at) {
        // LinkedIn tokens (without refresh) last 60 days: ask the broker to reconnect.
        db.insert('notifications', {
          user_id: a.user_id,
          message: left > 0 ? `Your ${NETWORKS[a.network]} connection expires on ${new Date(a.expires_at).toLocaleDateString('en-AU')}. Reconnect it on the Social page to keep posting.`
            : `Your ${NETWORKS[a.network]} connection has expired. Reconnect it on the Social page to keep posting.`,
          link: '#/social',
        });
        db.update('social_accounts', a.id, { expiry_warned_at: nowIso() });
      }
    } catch (err) {
      db.update('social_accounts', a.id, { last_error: err.message });
      log.warn?.(`[social] token refresh failed for account ${a.id}: ${err.message}`);
    }
  }
  return refreshed;
}

// ---- Images ----------------------------------------------------------------------------

// Picture links must be public https (tests use a local http server).
const testUrls = () => process.env.SOCIAL_ALLOW_PRIVATE_URLS === '1';
const httpsLink = (u) => /^https:\/\//i.test(u) || (testUrls() && /^http:\/\//i.test(u));

function blockedHost(url) {
  if (process.env.SOCIAL_ALLOW_PRIVATE_URLS === '1') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIPv4(host)) return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host);
  if (net.isIPv6(host)) return host === '::1' || /^f[cd]|^fe80/i.test(host);
  return false;
}

function checkImage(data, mime) {
  if (!['image/jpeg', 'image/png'].includes(mime)) throw new HttpError(400, 'Please use a JPG or PNG picture (Instagram doesn\'t accept other formats)');
  if (data.length > MAX_IMAGE) throw new HttpError(400, 'The picture is too large (8 MB at most)');
}

// An uploaded picture (data URI from the browser).
function saveUpload(dataUri, userId) {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,/.exec(String(dataUri || ''));
  if (!m) throw new HttpError(400, 'Please use a JPG or PNG picture (Instagram doesn\'t accept other formats)');
  return branding.saveImage(dataUri, { kind: 'social', userId, maxBytes: MAX_IMAGE });
}

// A picture already online: downloaded once (for LinkedIn and the preview);
// Instagram is given the link itself.
async function saveFromLink(link, userId) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch { throw new HttpError(400, 'That picture link doesn\'t look right'); }
  if (!httpsLink(url.href)) throw new HttpError(400, 'Picture links must start with https://');
  if (blockedHost(url)) throw new HttpError(400, 'That picture link points to a private address. Instagram needs a public link.');
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new HttpError(400, 'Couldn\'t download the picture from that link. Check it opens in a private browser window.');
  }
  if (!res.ok) throw new HttpError(400, `Couldn't download the picture from that link (${res.status}). It must be a public link.`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().replace('image/jpg', 'image/jpeg');
  if (!mime.startsWith('image/')) throw new HttpError(400, 'That link opens a web page, not a picture. Use the direct link to the image file (often "Copy image address").');
  const data = Buffer.from(await res.arrayBuffer());
  checkImage(data, mime);
  return branding.saveImage(`data:${mime};base64,${data.toString('base64')}`, { kind: 'social', userId, maxBytes: MAX_IMAGE });
}

// ---- Posts ------------------------------------------------------------------------------

const hashtags = (text) => (String(text).match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
const mentions = (text) => (String(text).match(/(^|\s)@[\w.]+/g) || []).length;

function imageInfo(assetId) {
  return assetId ? db.one('SELECT id, mime, width, height, length(data) AS bytes FROM assets WHERE id = ?', assetId) : null;
}

// Where Instagram can fetch the picture from, or null.
function instagramImageUrl(post) {
  if (post.image_url) return post.image_url;
  const base = publicBase();
  if (!base || !post.image_asset_id || !post.media_token) return null;
  const ext = imageInfo(post.image_asset_id)?.mime === 'image/png' ? 'png' : 'jpg';
  return `${base}/api/social/media/${post.media_token}.${ext}`;
}

// Problems that would stop a post going to a network.
function problems(post, networks) {
  const out = [];
  const body = String(post.body || '');
  const img = imageInfo(post.image_asset_id);
  if (!body.trim() && !img) out.push('Write something to post');
  if (networks.includes('linkedin') && body.length > LIMITS.linkedin) out.push(`LinkedIn posts can be up to ${LIMITS.linkedin.toLocaleString()} characters (this is ${body.length.toLocaleString()})`);
  if (networks.includes('instagram')) {
    if (!img) out.push('Instagram posts need a picture');
    if (body.length > LIMITS.instagram) out.push(`Instagram captions can be up to ${LIMITS.instagram.toLocaleString()} characters (this is ${body.length.toLocaleString()})`);
    if (hashtags(body) > LIMITS.instagram_hashtags) out.push(`Instagram allows up to ${LIMITS.instagram_hashtags} hashtags`);
    if (mentions(body) > LIMITS.instagram_mentions) out.push(`Instagram allows up to ${LIMITS.instagram_mentions} @mentions`);
    if (img && img.width && img.height) {
      const ratio = img.width / img.height;
      if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) out.push(`Instagram needs a picture between portrait 4:5 and landscape 1.91:1 (this one is ${img.width}×${img.height}). Crop it, e.g. to a square.`);
    }
    if (img && !instagramImageUrl(post)) {
      out.push('Instagram fetches the picture from the internet, and this CRM isn\'t on a public web address. Use "Picture from a link" (a public https link to the image) for Instagram posts.');
    }
  }
  return out;
}

function shapePost(p) {
  const targets = db.all('SELECT network, status, url, error, posted_at FROM social_post_targets WHERE post_id = ? ORDER BY network', p.id);
  const img = imageInfo(p.image_asset_id);
  return {
    id: p.id, user_id: p.user_id, author: p.author || null, body: p.body, alt_text: p.alt_text, image_url: p.image_url,
    image: img ? { id: img.id, url: `/assets/${img.id}`, width: img.width, height: img.height } : null,
    status: p.status, scheduled_at: p.scheduled_at, posted_at: p.posted_at, created_at: p.created_at, updated_at: p.updated_at, targets,
  };
}

function getPost(id) {
  const p = db.one('SELECT p.*, u.name AS author FROM social_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?', id);
  return p ? shapePost(p) : null;
}

function listPosts({ userId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('p.user_id = ?'); args.push(userId); }
  if (status === 'scheduled') where.push("p.status IN ('scheduled','publishing')");
  else if (status === 'posted') where.push("p.status IN ('posted','partly_posted')");
  else if (status) { where.push('p.status = ?'); args.push(status); }
  return db.all(
    `SELECT p.*, u.name AS author FROM social_posts p LEFT JOIN users u ON u.id = p.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE WHEN p.status IN ('scheduled','publishing') THEN 0 WHEN p.status = 'draft' THEN 1 ELSE 2 END,
              CASE WHEN p.status IN ('scheduled','publishing') THEN p.scheduled_at END,
              COALESCE(p.posted_at, p.updated_at) DESC LIMIT ?`,
    ...args, Math.min(500, Number(limit) || 100),
  ).map(shapePost);
}

// body: { body, alt_text, image_asset_id, image_url, networks: [...], action: 'draft'|'schedule'|'now', scheduled_at }
function savePost(userId, input, existingId = null) {
  const existing = existingId ? db.one('SELECT * FROM social_posts WHERE id = ?', existingId) : null;
  if (existingId && !existing) throw new HttpError(404, 'Post not found');
  if (existing && !['draft', 'scheduled', 'failed'].includes(existing.status)) throw new HttpError(400, 'This post has already gone out, so it can\'t be changed');
  const networks = [...new Set((Array.isArray(input.networks) ? input.networks : []).filter((n) => Object.hasOwn(NETWORKS, n)))];
  const action = ['draft', 'schedule', 'now'].includes(input.action) ? input.action : 'draft';
  const imageId = input.image_asset_id ? Number(input.image_asset_id) : null;
  if (imageId) {
    const a = db.one("SELECT id FROM assets WHERE id = ? AND kind = 'social'", imageId);
    if (!a) throw new HttpError(400, 'That picture is no longer available. Add it again.');
  }
  const row = {
    body: String(input.body ?? '').replace(/\r\n/g, '\n').slice(0, 5000),
    alt_text: input.alt_text ? String(input.alt_text).trim().slice(0, 1000) : null,
    image_asset_id: imageId,
    image_url: imageId && input.image_url && httpsLink(String(input.image_url)) ? String(input.image_url).trim() : null,
    media_token: imageId ? existing?.media_token || randomToken(18) : null,
    updated_at: nowIso(),
  };

  if (action !== 'draft') {
    if (!networks.length) throw new HttpError(400, 'Choose where to post (LinkedIn, Instagram or both)');
    for (const n of networks) {
      const a = accountFor(userId, n);
      if (!a) throw new HttpError(400, `Connect your ${NETWORKS[n]} account first`);
      if (a.expires_at && a.expires_at < nowIso()) throw new HttpError(400, `Your ${NETWORKS[n]} connection has expired. Reconnect it first.`);
    }
    const issues = problems(row, networks);
    if (issues.length) throw new HttpError(400, issues.join('. '));
  }
  let scheduledAt = null;
  if (action === 'schedule') {
    const t = Date.parse(input.scheduled_at || '');
    if (!Number.isFinite(t)) throw new HttpError(400, 'Choose when to post it');
    if (t < Date.now() - 60000) throw new HttpError(400, 'That time has already passed');
    if (t > Date.now() + days(180)) throw new HttpError(400, 'Posts can be scheduled up to 6 months ahead');
    scheduledAt = new Date(t).toISOString();
  }
  const status = action === 'draft' ? 'draft' : 'scheduled';
  const fields = { ...row, status, scheduled_at: action === 'now' ? nowIso() : scheduledAt };

  const id = db.transaction(() => {
    const postId = existing ? (db.update('social_posts', existing.id, fields), existing.id) : db.insert('social_posts', { ...fields, user_id: userId });
    db.run('DELETE FROM social_post_targets WHERE post_id = ?', postId);
    for (const n of networks) db.insert('social_post_targets', { post_id: postId, network: n });
    return postId;
  });
  return id;
}

function deletePost(id) {
  const p = db.one('SELECT status FROM social_posts WHERE id = ?', id);
  if (!p) return false;
  if (p.status === 'publishing') throw new HttpError(400, 'This post is being published right now');
  db.run('DELETE FROM social_posts WHERE id = ?', id);
  return true;
}

// ---- Publishing --------------------------------------------------------------------------

// LinkedIn "little text": these characters are markup unless escaped.
// Hashtags become LinkedIn hashtag links.
function linkedinText(text) {
  const escape = (s) => s.replace(/[\\|{}@[\]()<>*_~#]/g, (c) => `\\${c}`);
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    parts.push(escape(text.slice(last, start)), `{hashtag|\\#|${m[2]}}`);
    last = start + 1 + m[2].length;
  }
  parts.push(escape(text.slice(last)));
  return parts.join('');
}

const liHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': liVersion(), 'X-Restli-Protocol-Version': '2.0.0' });

async function publishLinkedin(account, post) {
  const token = decrypt(account.access_token);
  const author = `urn:li:person:${account.external_id}`;
  let content;
  if (post.image_asset_id) {
    const asset = db.one('SELECT mime, data FROM assets WHERE id = ?', post.image_asset_id);
    const { data: init } = await call(`${liApi()}/rest/images?action=initializeUpload`, {
      method: 'POST', headers: liHeaders(token), json: { initializeUploadRequest: { owner: author } },
    });
    const { uploadUrl, image } = init.value || {};
    if (!uploadUrl || !image) throw new SocialError('LinkedIn: the picture upload couldn\'t be started');
    await call(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': asset.mime }, body: Buffer.from(asset.data) });
    content = { media: { id: image, ...(post.alt_text ? { altText: post.alt_text.slice(0, 4086) } : {}) } };
  }
  const { headers, data } = await call(`${liApi()}/rest/posts`, {
    method: 'POST',
    headers: liHeaders(token),
    json: {
      author,
      commentary: linkedinText(post.body || ''),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(content ? { content } : {}),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    },
  });
  const urn = headers.get('x-restli-id') || data.id;
  return { external_id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Instagram: create a container, wait for it to be ready, then publish.
async function publishInstagram(account, post, target) {
  const token = decrypt(account.access_token);
  const base = `${igGraph()}/${IG_VERSION}`;
  let containerId = target.container_id;
  if (!containerId) {
    const imageUrl = instagramImageUrl(post);
    if (!imageUrl) throw new SocialError('Instagram needs the picture at a public web address. Use "Picture from a link".');
    const { data } = await call(`${base}/${account.external_id}/media`, {
      method: 'POST', form: { image_url: imageUrl, caption: post.body || '', ...(post.alt_text ? { alt_text: post.alt_text } : {}), access_token: token },
    }, 'Instagram');
    containerId = data.id;
    db.update('social_post_targets', target.id, { container_id: containerId });
  }
  const pause = Number(process.env.SOCIAL_POLL_MS ?? 2000);
  let status = 'IN_PROGRESS';
  for (let i = 0; i < 5 && status === 'IN_PROGRESS'; i += 1) {
    const { data } = await call(`${base}/${containerId}?${new URLSearchParams({ fields: 'status_code', access_token: token })}`, {}, 'Instagram');
    status = data.status_code || 'FINISHED';
    if (status === 'IN_PROGRESS') await wait(pause);
  }
  if (status === 'IN_PROGRESS') return { pending: true }; // try again on the next run
  if (status !== 'FINISHED') {
    db.update('social_post_targets', target.id, { container_id: null });
    throw new SocialError(`Instagram couldn't use the picture (${status}). Check the link opens the image directly and it's a JPG or PNG.`);
  }
  const { data: published } = await call(`${base}/${account.external_id}/media_publish`, { method: 'POST', form: { creation_id: containerId, access_token: token } }, 'Instagram');
  let url = null;
  try {
    const { data } = await call(`${base}/${published.id}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`, {}, 'Instagram');
    url = data.permalink || null;
  } catch { /* the post is live; the link is a nice-to-have */ }
  return { external_id: published.id, url };
}

const publishing = new Set();

// Sends a post to each network still pending. Safe to call repeatedly.
async function publish(postId) {
  if (publishing.has(postId)) return getPost(postId);
  const claimed = db.run("UPDATE social_posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status IN ('scheduled','publishing','failed','partly_posted')", nowIso(), postId).changes;
  if (!claimed) return getPost(postId);
  publishing.add(postId);
  try {
    const post = db.one('SELECT * FROM social_posts WHERE id = ?', postId);
    for (const target of db.all("SELECT * FROM social_post_targets WHERE post_id = ? AND status != 'posted'", postId)) {
      const account = accountFor(post.user_id, target.network);
      db.run('UPDATE social_post_targets SET attempts = attempts + 1 WHERE id = ?', target.id);
      try {
        if (!account) throw new SocialError(`${NETWORKS[target.network]} isn't connected any more. Reconnect it on the Social page.`);
        const r = target.network === 'linkedin' ? await publishLinkedin(account, post) : await publishInstagram(account, post, target);
        if (r.pending) continue;
        db.update('social_post_targets', target.id, { status: 'posted', external_id: r.external_id || null, url: r.url, error: null, posted_at: nowIso() });
      } catch (err) {
        const message = err instanceof SocialError || err instanceof HttpError ? err.message : `${NETWORKS[target.network]}: ${err.message}`;
        db.update('social_post_targets', target.id, { status: 'failed', error: err.expired ? `${message} Your ${NETWORKS[target.network]} connection may have expired. Reconnect it and try again.` : message });
        if (account && err.expired) db.update('social_accounts', account.id, { last_error: message });
      }
    }
    const targets = db.all('SELECT status FROM social_post_targets WHERE post_id = ?', postId);
    const posted = targets.filter((t) => t.status === 'posted').length;
    const failed = targets.filter((t) => t.status === 'failed').length;
    const pending = targets.length - posted - failed;
    const status = pending ? 'publishing' : posted === targets.length ? 'posted' : posted ? 'partly_posted' : 'failed';
    db.update('social_posts', postId, { status, posted_at: posted ? nowIso() : null, updated_at: nowIso() });
    if (failed && !pending) {
      db.insert('notifications', {
        user_id: post.user_id,
        message: `Social post ${posted ? 'partly ' : ''}failed: ${db.all("SELECT network FROM social_post_targets WHERE post_id = ? AND status = 'failed'", postId).map((t) => NETWORKS[t.network]).join(' and ')} didn't accept it.`,
        link: '#/social',
      });
    }
  } finally {
    publishing.delete(postId);
  }
  return getPost(postId);
}

// Retry only the networks that failed.
function retry(postId) {
  db.run("UPDATE social_post_targets SET status = 'pending', error = NULL WHERE post_id = ? AND status = 'failed'", postId);
  db.run("UPDATE social_posts SET status = 'scheduled', scheduled_at = ? WHERE id = ? AND status IN ('failed','partly_posted')", nowIso(), postId);
  return publish(postId);
}

// Scheduler: posts that are due (and Instagram posts still processing).
async function publishDue(log = console) {
  let n = 0;
  const due = db.all("SELECT id FROM social_posts WHERE (status = 'scheduled' AND scheduled_at <= ?) OR status = 'publishing' ORDER BY scheduled_at LIMIT 20", nowIso());
  for (const { id } of due) {
    try {
      const p = await publish(id);
      if (p && ['posted', 'partly_posted'].includes(p.status)) n += 1;
    } catch (err) {
      log.error?.(`[social] post ${id} failed`, err);
    }
  }
  return n;
}

const mediaFor = (token) => {
  const p = db.one("SELECT image_asset_id FROM social_posts WHERE media_token = ? AND status != 'draft'", token);
  return p?.image_asset_id ? db.one('SELECT mime, data FROM assets WHERE id = ?', p.image_asset_id) : null;
};

module.exports = {
  NETWORKS, LIMITS, appConfig, saveAppConfig, configured, publicBase, redirectUri, startConnect, finishConnect, connectInstagramToken, disconnect,
  publicAccount, accountFor, refreshTokens, saveUpload, saveFromLink, savePost, getPost, listPosts, deletePost, publish, retry, publishDue,
  problems, linkedinText, mediaFor, instagramImageUrl, SocialError,
};
