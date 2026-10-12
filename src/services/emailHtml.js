'use strict';
// Turns the CRM's plain-text emails into branded HTML emails with the sender's
// signature, and cleans pasted signatures.
const sanitizeHtml = require('sanitize-html');
const db = require('../db');
const branding = require('./branding');
const lenderLogos = require('./lenderLogos');
const graphics = require('./emailGraphics');

// Scales an image to fit a box without upscaling.
function fit(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
const { HttpError } = require('../util');

const MAX_SIGNATURE = 300 * 1024;
const FONT = 'Arial, Helvetica, sans-serif';

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const linkify = (s, colour) => s.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (url) => `<a href="${url}" style="color:${colour};">${url}</a>`);
const BULLET = /^\s*(?:[-•*])\s+/;

// Paragraphs, line breaks and clickable links from plain text. A paragraph
// starting "# " becomes a heading in the brand colour; lines starting "-" or
// "•" become a bulleted list.
function textToHtml(text, linkColour, headingColour = linkColour) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((para) => para.trim())
    .map((para) => {
      const lines = para.split('\n').filter((l) => l.trim());
      if (/^#{1,3}\s+/.test(para)) {
        const [first, ...rest] = para.split('\n');
        const heading = `<h2 style="margin:6px 0 10px 0;font-size:19px;line-height:1.3;color:${headingColour};">${escape(first.replace(/^#{1,3}\s+/, ''))}</h2>`;
        return rest.length ? `${heading}\n${textToHtml(rest.join('\n'), linkColour, headingColour)}` : heading;
      }
      if (lines.length && lines.every((l) => BULLET.test(l))) {
        return `<ul style="margin:0 0 14px 0;padding-left:22px;">${lines.map((l) => `<li style="margin:0 0 4px 0;">${linkify(escape(l.replace(BULLET, '')), linkColour)}</li>`).join('')}</ul>`;
      }
      return `<p style="margin:0 0 14px 0;">${linkify(escape(para), linkColour).replace(/\n/g, '<br>')}</p>`;
    })
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

// The body with graphic tags ([[progress]], [[button: …]]…) swapped for
// charts/diagrams (html) and their plain-text versions (text). Tags with
// nothing to show are dropped, or flagged in previews.
function renderBody(body, colours, context, preview) {
  const htmlParts = [];
  const textParts = [];
  let src = null;
  for (const para of String(body || '').replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const tag = graphics.parseTag(para);
    if (!tag) {
      htmlParts.push(textToHtml(para, colours.link, colours.dark));
      textParts.push(para);
      continue;
    }
    src = src || graphics.dataSource(context || {});
    const out = graphics.render(tag, src, colours);
    if (out) {
      htmlParts.push(out.html);
      if (out.text) textParts.push(out.text);
    } else if (preview) {
      const g = graphics.GRAPHICS.find((x) => x.key === tag.key);
      const why = {
        button: "its link is blank for this client (for a booking link, connect Calendly in Settings) or isn't a web address",
        image: 'the picture has been removed',
      }[g.key] || `this email isn't linked to a ${g.needs} with the details it needs`;
      htmlParts.push(`<p style="margin:0 0 14px 0;padding:8px 12px;border:1px dashed #c5ccd4;border-radius:6px;color:#5f6b7a;font-size:13px;">${escape(g.label)} not shown: ${escape(why)}. Clients never see this note; the ${g.key === 'button' || g.key === 'image' ? g.key : 'graphic'} is just left out.</p>`);
    }
  }
  return { html: htmlParts.join('\n'), text: textParts.join('\n\n') };
}

// Business details shown in the footer of branded emails.
function footerHtml(brand, colours) {
  const s = (k) => db.getSetting(k, '');
  const website = s('business_website');
  const href = website && !/^https?:\/\//i.test(website) ? `https://${website}` : website;
  const contact = [
    s('business_phone') ? escape(s('business_phone')) : null,
    s('business_email') ? `<a href="mailto:${escape(s('business_email'))}" style="color:${colours.link};text-decoration:none;">${escape(s('business_email'))}</a>` : null,
    website ? `<a href="${escape(href)}" style="color:${colours.link};text-decoration:none;">${escape(website.replace(/^https?:\/\//i, ''))}</a>` : null,
  ].filter(Boolean);
  const lines = [
    `<strong style="color:${colours.dark};font-size:13px;">${escape(brand.business_name)}</strong>`,
    contact.length ? contact.join(' &nbsp;·&nbsp; ') : null,
    s('acl_number') ? escape(s('acl_number')) : null,
    brand.email_footer ? escape(brand.email_footer).replace(/\n/g, '<br>') : null,
  ].filter(Boolean);
  return `<tr><td bgcolor="${colours.soft}" style="background:${colours.soft};padding:18px 32px;font-family:${FONT};font-size:12px;line-height:1.6;color:#4b5563;border-radius:0 0 6px 6px;">${lines.join('<br>')}</td></tr>`;
}

// Returns { html, text, plain, attachments } for a plain-text body sent by userId.
// `context` ({ contactId, dealId, loanId }, or { sample: true } for template
// previews) supplies the data for any graphics in the body. `reply` leaves
// out the branded frame so it sits naturally above the quoted thread.
function buildEmail({ body, senderUserId = null, reply = false, preview = false, context = null }) {
  const brand = branding.getBrand();
  const colours = branding.emailColours();
  const signature = signatureFor(senderUserId);
  const rendered = renderBody(body, colours, context, preview);
  const content = `${rendered.html}\n<div class="signature" style="margin-top:4px;">${signature}</div>`;
  const text = `${rendered.text.trim()}\n\n${htmlToText(signature)}`.trim();

  // Lenders named in the email get their logo shown (not on replies).
  const lenderLogoList = reply ? [] : lenderLogos.mentionedIn(body).map((l) => ({ l, a: branding.getAsset(l.logo_asset_id) }));
  const lenderImg = ({ l, a }, maxW = 120, maxH = 36, margin = 'margin-left:12px;') => {
    const { width, height } = fit(a.width, a.height, maxW, maxH);
    return `<img src="/assets/${a.id}" width="${width}" height="${height}" alt="${escape(l.name)}" style="border:0;width:${width}px;height:${height}px;vertical-align:middle;${margin}">`;
  };
  const lenderImgs = lenderLogoList.map((x) => lenderImg(x));

  let html;
  if (reply || brand.email_style === 'plain') {
    const lenderRow = lenderImgs.length ? `<div style="margin:4px 0 14px 0;">${lenderImgs.join('').replace(/margin-left:12px/g, 'margin-right:12px')}</div>` : '';
    const phoneStyle = rendered.html.includes('efh-hide-sm') ? '<style>@media only screen and (max-width:480px){.efh-hide-sm{display:none !important;}}</style>' : '';
    html = `${phoneStyle}<div style="font-family:${FONT};font-size:15px;line-height:1.5;color:#1f2933;">${content.replace('<div class="signature"', `${lenderRow}<div class="signature"`)}</div>`;
  } else {
    const banner = brand.email_style === 'banner';
    let header = '';
    let brandImg = '';
    if (brand.logo && brand.email_logo) {
      const { width, height } = fit(brand.logo.width, brand.logo.height, 220, banner ? 48 : 56);
      brandImg = `<img src="${brand.logo.url}" width="${width}" height="${height}" alt="${escape(brand.business_name)}" style="display:block;border:0;width:${width}px;height:${height}px;">`;
    }
    if (banner) {
      // Colour band; logos sit on white chips so any logo reads well on it.
      const chip = (inner, pad = '8px 12px') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:6px;padding:${pad};">${inner}</td></tr></table>`;
      const left = brandImg ? chip(brandImg) : `<span style="font-family:${FONT};font-size:20px;font-weight:bold;color:${colours.onPrimary};">${escape(brand.business_name)}</span>`;
      const right = lenderLogoList.map((x) => chip(lenderImg(x, 100, 28, ''), '6px 10px')).join('&nbsp;');
      header = `<tr><td bgcolor="${colours.primary}" style="background:${colours.primary};padding:20px 32px;border-radius:6px 6px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">${left}</td><td align="right" valign="middle">${right}</td></tr></table></td></tr>`;
    } else if (brandImg || lenderImgs.length) {
      header = `<tr><td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">${brandImg}</td><td align="right" valign="middle">${lenderImgs.join('')}</td></tr></table></td></tr>`;
    }
    html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>@media only screen and (max-width:480px){.efh-hide-sm{display:none !important;}}</style></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;${banner ? '' : `border-top:5px solid ${colours.primary};`}border-radius:6px;">
${header}
<tr><td style="padding:${banner ? '28px' : '24px'} 32px 28px 32px;font-family:${FONT};font-size:15px;line-height:1.55;color:#1f2933;">
${content}
</td></tr>
${brand.email_footer_details ? footerHtml(brand, colours) : ''}
</table>
</td></tr></table>
</body></html>`;
  }
  const inlined = inlineAssets(html, preview);
  return { html: inlined.html, text, plain: rendered.text.trim(), attachments: inlined.attachments };
}

module.exports = { buildEmail, cleanSignature, signatureFor, textToHtml, htmlToText, escape };
