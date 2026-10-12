'use strict';
// Turns the CRM's plain-text emails into branded HTML emails with the sender's
// signature, and cleans pasted signatures.
const sanitizeHtml = require('sanitize-html');
const db = require('../db');
const branding = require('./branding');
const { HttpError } = require('../util');

const MAX_SIGNATURE = 300 * 1024;
const FONT = 'Arial, Helvetica, sans-serif';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Paragraphs, line breaks and clickable links from plain text.
function textToHtml(text, linkColour) {
  const linkify = (s) => s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (url) => `<a href="${url}" style="color:${linkColour};">${url}</a>`);
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px 0;">${linkify(escape(para)).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Signatures ----------------------------------------------------------------

const unsafeStyle = (style) => /expression\s*\(|url\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(style || '');

// Cleans signature HTML pasted from Outlook (or anywhere). Embedded images are
// stored as CRM assets; web images are kept; images that only exist on the
// sender's computer (file:, cid:) are removed and counted.
function cleanSignature(html, userId) {
  let removedImages = 0;
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: [
      'p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'sup', 'sub', 'font', 'a', 'img', 'hr',
      'table', 'thead', 'tbody', 'tr', 'td', 'th', 'col', 'colgroup', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'small', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'dir'],
      a: ['href', 'title', 'target', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style', 'border'],
      font: ['face', 'size', 'color', 'style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attribs) => {
        if (unsafeStyle(attribs.style)) delete attribs.style;
        return { tagName, attribs };
      },
      img: (tagName, attribs) => {
        if (unsafeStyle(attribs.style)) delete attribs.style;
        const src = String(attribs.src || '');
        if (src.startsWith('data:')) {
          attribs.src = `/assets/${branding.saveImage(src, { kind: 'signature', userId, maxBytes: 512 * 1024 })}`;
        } else if (!/^\/assets\/\d+$/.test(src) && !/^https:\/\//i.test(src)) {
          removedImages++;
          return { tagName: 'img', attribs: {} };
        }
        return { tagName, attribs };
      },
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  }).trim();
  if (clean.length > MAX_SIGNATURE) throw new HttpError(400, 'That signature is too large. Try removing large images.');
  return { html: clean, removedImages };
}

function fallbackSignature(user) {
  const business = db.getSetting('business_name', '');
  const lines = [user?.name, business, user?.phone].filter(Boolean).map(escape);
  return lines.length ? `<p style="margin:0;">${lines.join('<br>')}</p>` : '';
}

function signatureFor(userId) {
  const user = userId ? db.one('SELECT name, phone, signature_html FROM users WHERE id = ?', userId) : null;
  return user?.signature_html || fallbackSignature(user);
}

// ---- Building emails --------------------------------------------------------------

// Swaps /assets/N image paths for cid: references (email) or leaves them as
// URLs (on-screen preview), collecting the inline attachments needed.
function inlineAssets(html, forPreview) {
  const attachments = new Map();
  const out = html.replace(/src="\/assets\/(\d+)"/g, (whole, id) => {
    if (forPreview) return whole;
    const asset = branding.getAsset(Number(id));
    if (!asset) return 'src=""';
    const cid = `asset-${id}@efh-crm`;
    const ext = asset.mime.split('/')[1].replace('jpeg', 'jpg');
    attachments.set(cid, { cid, filename: `image-${id}.${ext}`, mime: asset.mime, data: Buffer.from(asset.data) });
    return `src="cid:${cid}"`;
  });
  return { html: out, attachments: [...attachments.values()] };
}

// Returns { html, text, attachments } for a plain-text body sent by userId.
// `reply` leaves out the branded frame so it sits naturally above the quoted thread.
function buildEmail({ body, senderUserId = null, reply = false, preview = false }) {
  const brand = branding.getBrand();
  const colours = branding.emailColours();
  const signature = signatureFor(senderUserId);
  const content = `${textToHtml(body, colours.link)}\n<div class="signature" style="margin-top:4px;">${signature}</div>`;
  const text = `${String(body || '').trim()}\n\n${htmlToText(signature)}`.trim();

  let html;
  if (reply || brand.email_style === 'plain') {
    html = `<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:#1f2933;">${content}</div>`;
  } else {
    let logoRow = '';
    if (brand.logo && brand.email_logo) {
      const height = Math.min(56, brand.logo.height);
      const width = Math.min(220, Math.round((height * brand.logo.width) / brand.logo.height));
      const finalHeight = Math.round((width * brand.logo.height) / brand.logo.width);
      logoRow = `<tr><td style="padding:24px 32px 0 32px;"><img src="${brand.logo.url}" width="${width}" height="${finalHeight}" alt="${escape(brand.business_name)}" style="display:block;border:0;width:${width}px;height:${finalHeight}px;"></td></tr>`;
    }
    html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-top:5px solid ${colours.primary};border-radius:6px;">
${logoRow}
<tr><td style="padding:24px 32px 28px 32px;font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2933;">
${content}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  }
  const inlined = inlineAssets(html, preview);
  return { html: inlined.html, text, attachments: inlined.attachments };
}

module.exports = { buildEmail, cleanSignature, signatureFor, textToHtml, htmlToText, escape };
