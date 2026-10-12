'use strict';
// Business branding: logo, colours and email style. Produces the stylesheet
// that themes the CRM (/brand.css) and the details used to build emails.
const db = require('../db');
const { HttpError } = require('../util');

const DEFAULTS = { primary: '#1f5fbf', sidebar: '#12213a' };
const MAX_LOGO_BYTES = 1024 * 1024;

// ---- Colour maths ------------------------------------------------------------

const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

// Nudges a colour towards black or white until it reads well on `bg`.
function readableOn(colour, bg, min = 4.5) {
  const towards = luminance(bg) > 0.5 ? '#000000' : '#ffffff';
  let c = colour;
  for (let t = 0.05; contrast(c, bg) < min && t <= 1; t += 0.05) c = mix(colour, towards, t);
  return c;
}

const textOn = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111');

// ---- Settings ----------------------------------------------------------------

function getBrand() {
  const logoId = Number(db.getSetting('brand_logo_id', 0)) || null;
  const logo = logoId ? db.one('SELECT id, mime, width, height FROM assets WHERE id = ?', logoId) : null;
  return {
    business_name: db.getSetting('business_name', 'EFH Mortgage Broking'),
    primary: db.getSetting('brand_primary', '') || DEFAULTS.primary,
    sidebar: db.getSetting('brand_sidebar', '') || DEFAULTS.sidebar,
    customised: Boolean(db.getSetting('brand_primary', '') || db.getSetting('brand_sidebar', '')),
    email_style: db.getSetting('brand_email_style', 'branded') || 'branded',
    email_logo: db.getSetting('brand_email_logo', '1') !== '0',
    logo: logo ? { id: logo.id, url: `/assets/${logo.id}`, width: logo.width, height: logo.height } : null,
    version: db.getSetting('brand_version', '0'),
  };
}

function bump() {
  db.setSetting('brand_version', String(Date.now()));
}

function saveBrand({ primary, sidebar, email_style, email_logo }) {
  for (const [key, value] of [['brand_primary', primary], ['brand_sidebar', sidebar]]) {
    if (value === undefined) continue;
    if (value && !isHex(value)) throw new HttpError(400, 'Colours must look like #1f5fbf');
    db.setSetting(key, value ? value.toLowerCase() : '');
  }
  if (email_style !== undefined) {
    if (!['branded', 'plain'].includes(email_style)) throw new HttpError(400, 'Unknown email style');
    db.setSetting('brand_email_style', email_style);
  }
  if (email_logo !== undefined) db.setSetting('brand_email_logo', email_logo ? '1' : '0');
  bump();
  return getBrand();
}

// ---- Images ------------------------------------------------------------------

// Reads pixel dimensions from PNG, JPEG or GIF bytes.
function imageSize(buf, mime) {
  if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (mime === 'image/gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Stores a data: URI image. Only PNG, JPEG and GIF, which every email client shows.
function saveImage(dataUri, { kind, userId = null, maxBytes = MAX_LOGO_BYTES }) {
  const m = /^data:(image\/(?:png|jpeg|jpg|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUri || ''));
  if (!m) throw new HttpError(400, 'Please use a PNG, JPG or GIF image');
  const mime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const data = Buffer.from(m[2], 'base64');
  if (data.length > maxBytes) throw new HttpError(400, `Image is too large (max ${Math.round(maxBytes / 1024)} KB)`);
  const size = imageSize(data, mime);
  if (!size || !size.width || !size.height) throw new HttpError(400, 'That image file could not be read');
  return db.insert('assets', { kind, mime, data, width: size.width, height: size.height, user_id: userId });
}

function setLogo(dataUri) {
  const id = saveImage(dataUri, { kind: 'logo' });
  db.setSetting('brand_logo_id', String(id));
  bump();
  return getBrand();
}

function removeLogo() {
  db.setSetting('brand_logo_id', '');
  bump();
  return getBrand();
}

const getAsset = (id) => db.one('SELECT id, mime, data, width, height FROM assets WHERE id = ?', id);

// ---- Stylesheet ------------------------------------------------------------------

function css() {
  const b = getBrand();
  if (!b.customised) return '/* default theme */\n';
  const lightBg = '#ffffff';
  const darkBg = '#181c22';
  const accent = readableOn(b.primary, lightBg);
  const accentDark = readableOn(b.primary, darkBg);
  const sidebarIsDark = luminance(b.sidebar) < 0.35;
  const sidebarVars = (bg) => {
    const dark = luminance(bg) < 0.35;
    return `
    --sidebar: ${bg};
    --sidebar-text: ${dark ? mix(bg, '#ffffff', 0.78) : mix(bg, '#000000', 0.72)};
    --sidebar-strong: ${dark ? '#ffffff' : '#111111'};
    --sidebar-hover: ${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};
    --sidebar-active: ${dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.10)'};`;
  };
  const light = `
    --accent: ${accent};
    --accent-hover: ${mix(accent, '#000000', 0.15)};
    --accent-soft: ${mix(b.primary, '#ffffff', 0.88)};
    --on-accent: ${textOn(accent)};
    --series-1: ${accent};${sidebarVars(b.sidebar)}`;
  const dark = `
    --accent: ${accentDark};
    --accent-hover: ${mix(accentDark, '#ffffff', 0.15)};
    --accent-soft: ${mix(b.primary, darkBg, 0.72)};
    --on-accent: ${textOn(accentDark)};
    --series-1: ${accentDark};${sidebarVars(sidebarIsDark ? mix(b.sidebar, '#000000', 0.35) : mix(b.sidebar, '#000000', 0.7))}`;
  return `/* generated from Settings → Branding */
:root {${light}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${dark}
  }
}
:root[data-theme="dark"] {${dark}
}
`;
}

// Colours for emails, which always have a white background.
function emailColours() {
  const b = getBrand();
  return { primary: b.primary, link: readableOn(b.primary, '#ffffff') };
}

module.exports = {
  getBrand, saveBrand, setLogo, removeLogo, saveImage, getAsset, css, emailColours,
  imageSize, contrast, readableOn, isHex,
};
