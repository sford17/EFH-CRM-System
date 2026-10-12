'use strict';
// Which charts/diagrams the standard email templates include, and where.
// `after`: inserted after that paragraph (0 = the "Hi …," line).
// `replace`: replaces the paragraph containing that text.
// `end`: inserted just before the sign-off.

const BOOK = (label) => `[[button: ${label} | {{broker.booking_link}}]]`;

const TEMPLATE_GRAPHICS = {
  'Welcome – new enquiry': { end: [BOOK('Book a time to chat')] },
  'Document request': { replace: ['{{deal.outstanding_documents}}', '[[documents]]'] },
  'Pre-approval obtained': { after: [1, '[[progress]]', '[[key_dates]]'] },
  'Pre-approval expiring': { after: [1, '[[key_dates]]'] },
  'Application lodged': { after: [1, '[[progress]]', '[[loan_summary]]'] },
  'Conditional approval': { after: [1, '[[progress]]', '[[key_dates]]'] },
  'Unconditional approval': { after: [1, '[[progress]]', '[[key_dates]]'] },
  'Settlement reminder': { after: [1, '[[key_dates]]', '[[loan_summary]]'] },
  'Settlement congratulations': { after: [1, '[[progress]]', '[[loan_summary]]'] },
  'Fixed rate expiry review': { after: [1, '[[fixed_rate]]'], end: [BOOK('Book my review')] },
  'Annual loan review': { after: [1, '[[position]]', '[[lending_structure]]', '[[value_history]]'], end: [BOOK('Book my health check')] },
  'Rate reduction': { after: [2, '[[lending_structure]]'], end: [BOOK('Book a rate review')] },
};

function applyTemplateGraphics(name, body) {
  const spec = TEMPLATE_GRAPHICS[name];
  if (!spec) return body;
  let paras = String(body).split('\n\n');
  if (spec.replace) {
    const [find, tag] = spec.replace;
    paras = paras.map((p) => (p.includes(find) ? tag : p));
  }
  if (spec.after) {
    const [index, ...tags] = spec.after;
    paras.splice(index + 1, 0, ...tags);
  }
  if (spec.end) paras.splice(paras.length - 1, 0, ...spec.end);
  return paras.join('\n\n');
}

module.exports = { TEMPLATE_GRAPHICS, applyTemplateGraphics };
