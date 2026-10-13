'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const social = require('../services/social');
const { HttpError } = require('../util');
const { intParam, notFound } = require('./helpers');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const requestBase = (req) => `${req.protocol}://${req.get('host')}`;

// Without sign-in: the sign-in callbacks (the one-time `state` identifies the
// broker) and post pictures, which Instagram downloads itself.
const publicRouter = express.Router();

publicRouter.get('/callback/:network', async (req, res) => {
  const network = Object.hasOwn(social.NETWORKS, req.params.network) ? req.params.network : null;
  if (!network) throw new HttpError(404, 'Not found');
  const name = social.NETWORKS[network];
  let title = `${name} connected`;
  let message;
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error_reason || req.query.error);
    const { account } = await social.finishConnect(network, { code: req.query.code, state: req.query.state });
    message = `${account.username ? `@${account.username}` : account.name || 'Your account'} is connected. You can now post to ${name} from the Social page.`;
  } catch (err) {
    title = `${name} could not be connected`;
    message = err.message;
  }
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="4;url=/#/social"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles.css"></head><body><div class="auth-wrap"><div class="auth-card">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/#/social">Back to the CRM</a>
</div></div></body></html>`);
});

publicRouter.get('/media/:file', (req, res) => {
  const m = /^([A-Za-z0-9_-]{16,40})\.(jpg|png)$/.exec(req.params.file);
  const asset = m ? social.mediaFor(m[1]) : null;
  if (!asset) throw new HttpError(404, 'Not found');
  res.set('Content-Type', asset.mime).set('Cache-Control', 'public, max-age=3600').send(Buffer.from(asset.data));
});

const router = express.Router();

router.get('/status', (req, res) => {
  const cfg = social.appConfig();
  const base = requestBase(req);
  res.json({
    networks: Object.entries(social.NETWORKS).map(([key, label]) => ({
      key, label, configured: social.configured(key),
      account: social.publicAccount(social.accountFor(req.user.id, key)),
      redirect_uri: social.redirectUri(key, base),
    })),
    public_base: social.publicBase(),
    limits: social.LIMITS,
    app: req.user.role === 'admin' ? {
      linkedin_client_id: cfg.linkedin.clientId, has_linkedin_secret: Boolean(cfg.linkedin.clientSecret),
      instagram_app_id: cfg.instagram.clientId, has_instagram_secret: Boolean(cfg.instagram.clientSecret),
    } : undefined,
    team: db.all(`SELECT u.name, a.network, a.name AS account_name, a.username, a.expires_at FROM social_accounts a JOIN users u ON u.id = a.user_id ORDER BY u.name, a.network`),
  });
});

router.put('/config', auth.requireRole('admin'), (req, res) => {
  social.saveAppConfig(req.body || {});
  res.json({ linkedin: social.configured('linkedin'), instagram: social.configured('instagram') });
});

router.post('/connect/:network', (req, res) => {
  res.json({ url: social.startConnect(req.params.network, req.user.id, requestBase(req)) });
});

router.post('/instagram/token', async (req, res) => {
  res.json(social.publicAccount(await social.connectInstagramToken(req.user.id, req.body?.token)));
});

router.post('/disconnect/:network', (req, res) => {
  if (!Object.hasOwn(social.NETWORKS, req.params.network)) throw new HttpError(404, 'Unknown network');
  social.disconnect(req.user.id, req.params.network);
  res.json({ ok: true });
});

// Pictures: uploaded ({ image: data URI }) or downloaded from a link ({ url }).
router.post('/images', async (req, res) => {
  const id = req.body?.url ? await social.saveFromLink(req.body.url, req.user.id) : social.saveUpload(req.body?.image, req.user.id);
  const a = db.one('SELECT id, width, height FROM assets WHERE id = ?', id);
  res.status(201).json({ id: a.id, url: `/assets/${a.id}`, width: a.width, height: a.height });
});

router.get('/posts', (req, res) => {
  res.json({ rows: social.listPosts({ userId: req.query.mine === '1' ? req.user.id : null, status: req.query.status || null }) });
});

router.get('/posts/:id', (req, res) => res.json(notFound(social.getPost(intParam(req.params.id)), 'Post')));

// Only the author edits or sends their post (it goes out on their accounts).
const own = (req) => {
  const p = notFound(db.one('SELECT user_id FROM social_posts WHERE id = ?', intParam(req.params.id)), 'Post');
  if (p.user_id !== req.user.id && req.user.role !== 'admin') throw new HttpError(403, 'Only the person who wrote this post can change it');
  return p;
};

async function afterSave(id, action) {
  return action === 'now' ? social.publish(id) : social.getPost(id);
}

router.post('/posts', async (req, res) => {
  const id = social.savePost(req.user.id, req.body || {});
  res.status(201).json(await afterSave(id, req.body?.action));
});

router.put('/posts/:id', async (req, res) => {
  const p = own(req);
  const id = social.savePost(p.user_id, req.body || {}, intParam(req.params.id));
  res.json(await afterSave(id, req.body?.action));
});

router.post('/posts/:id/retry', async (req, res) => {
  own(req);
  res.json(await social.retry(intParam(req.params.id)));
});

router.delete('/posts/:id', (req, res) => {
  own(req);
  social.deletePost(intParam(req.params.id));
  res.json({ ok: true });
});

module.exports = { publicRouter, router };
