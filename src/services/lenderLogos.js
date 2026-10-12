'use strict';
// Lender logos: uploaded (best – from the lender's broker portal) or fetched
// as the lender website's icon. Used in the pipeline, the mortgage tracker,
// lending review documents and client emails that mention the lender.
const db = require('../db');
const branding = require('./branding');
const { HttpError } = require('../util');

const MAX_BYTES = 400 * 1024;
const iconService = () => process.env.LOGO_FETCH_URL || 'https://www.google.com/s2/favicons';

function lender(id) {
  const l = db.one('SELECT * FROM lenders WHERE id = ?', id);
  if (!l) throw new HttpError(404, 'Lender not found');
  return l;
}

function setLogo(lenderId, dataUri) {
  lender(lenderId);
  const assetId = branding.saveImage(dataUri, { kind: 'lender_logo', maxBytes: MAX_BYTES });
  db.update('lenders', lenderId, { logo_asset_id: assetId });
  return assetId;
}

function removeLogo(lenderId) {
  lender(lenderId);
  db.update('lenders', lenderId, { logo_asset_id: null });
}

const cleanDomain = (site) => String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

async function fetchFromWebsite(lenderId) {
  const l = lender(lenderId);
  const domain = cleanDomain(l.website);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, 'Add the lender\'s website (e.g. westpac.com.au) first');
  let res;
  try {
    res = await fetch(`${iconService()}?domain=${encodeURIComponent(domain)}&sz=128`, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
  } catch {
    throw new HttpError(502, 'Couldn\'t reach the logo service – check your internet connection, or upload a logo instead');
  }
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || !['image/png', 'image/jpeg'].includes(mime) || buf.length > MAX_BYTES) {
    throw new HttpError(502, `No logo found for ${domain} – please upload one`);
  }
  const size = branding.imageSize(buf, mime);
  // The service answers unknown sites with a tiny generic globe.
  if (!size || size.width < 32 || size.height < 32) throw new HttpError(502, `${domain} only has a tiny icon – please upload a logo instead`);
  return setLogo(lenderId, `data:${mime};base64,${buf.toString('base64')}`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lenders (with logos) named in a piece of text. Short names like "ING" or
// "NAB" must match in capitals so they don't fire on ordinary words.
function mentionedIn(text, limit = 3) {
  const body = String(text || '');
  if (!body) return [];
  const found = [];
  for (const l of db.all('SELECT id, name, logo_asset_id FROM lenders WHERE logo_asset_id IS NOT NULL ORDER BY length(name) DESC')) {
    const name = l.name.trim();
    if (!name) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, name.length <= 4 ? '' : 'i');
    const at = body.search(re);
    if (at !== -1 && !found.some((f) => f.name.toLowerCase().includes(name.toLowerCase()))) found.push({ ...l, at });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, limit);
}

// Image bytes for documents (PNG/JPEG only).
function logoData(assetId) {
  if (!assetId) return null;
  const a = branding.getAsset(assetId);
  if (!a || !['image/png', 'image/jpeg'].includes(a.mime)) return null;
  return { id: a.id, mime: a.mime, data: Buffer.from(a.data), width: a.width, height: a.height, url: `/assets/${a.id}` };
}

module.exports = { setLogo, removeLogo, fetchFromWebsite, mentionedIn, logoData, cleanDomain };
