// Email graphics ([[progress]], [[button: …]]…) in the template editor and
// in plain-text previews.
import { h, state, modal, field, readForm, toast, api, attempt } from '../core.js';

const TAG = /^\[\[\s*([a-z_]+)\s*(?::\s*([\s\S]*?))?\s*\]\]$/i;
export const graphicFor = (para) => {
  const m = TAG.exec(String(para).trim());
  return m ? state.meta.email_graphics.find((g) => g.key === m[1].toLowerCase()) || null : null;
};

// A template body as text, with graphic tags shown as labelled chips.
export function bodyPreview(text) {
  return h('div.body-preview', String(text || '').split(/\n{2,}/).map((para) => {
    const g = graphicFor(para);
    if (!g) return h('p.pre', para);
    const label = g.key === 'button' ? `Button: ${(TAG.exec(para.trim())[2] || '').split('|')[0].trim()}` : g.label;
    return h('div.graphic-chip', { title: g.hint }, h('span.graphic-icon', { 'aria-hidden': 'true' }, g.key === 'button' ? '▭' : g.key === 'image' ? '🖼' : '📊'), label);
  }));
}

// Puts a tag on its own paragraph at the cursor.
export function insertAtCursor(textarea, tag) {
  const { value, selectionStart: start, selectionEnd: end } = textarea;
  const before = value.slice(0, start).replace(/\s*$/, '');
  const after = value.slice(end).replace(/^\s*/, '');
  textarea.value = `${before}${before ? '\n\n' : ''}${tag}${after ? '\n\n' : ''}${after}`;
  const pos = (before ? before.length + 2 : 0) + tag.length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  textarea.dispatchEvent(new Event('input'));
}

const pickImage = () => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return resolve(null);
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
  input.click();
});

function buttonDialog(textarea) {
  const fields = [
    { name: 'label', label: 'Button text', required: true, full: true, default: 'Book a time' },
    { name: 'link', label: 'Goes to', type: 'select', required: true, full: true, default: '{{broker.booking_link}}', options: [
      ['{{broker.booking_link}}', 'My Calendly booking link (filled in for each client)'],
      ['{{business.website}}', 'My website'],
      ['custom', 'Another web address…'],
    ] },
    { name: 'url', label: 'Web address (if "another")', placeholder: 'https://…', full: true },
  ];
  const form = h('form.grid-form', fields.map((f) => field(f)),
    h('p.muted.small.full', 'If the link is blank for a client (e.g. no Calendly connected), the button is left out of their email.'),
    h('div.actions.full', h('button', { type: 'submit' }, 'Insert button')));
  const d = modal('Insert a button', form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    const url = v.link === 'custom' ? (v.url || '').trim() : v.link;
    if (!/^(https?:\/\/|mailto:|tel:|\{\{)/i.test(url)) return toast('Enter a web address starting with https://', 'error');
    insertAtCursor(textarea, `[[button: ${v.label.replace(/[|\]]/g, ' ')} | ${url}]]`);
    d.close();
  });
}

// Toolbar shown above a template's body.
export function graphicsToolbar(textarea, { onPreview } = {}) {
  const charts = state.meta.email_graphics.filter((g) => !['button', 'image'].includes(g.key));
  const select = h('select', { 'aria-label': 'Insert a chart or diagram' },
    h('option', { value: '' }, '📊 Insert chart or diagram…'),
    ['deal', 'contact', 'loan'].map((needs) => h('optgroup', { label: { deal: 'About the deal', contact: 'From the mortgage tracker', loan: 'About a loan' }[needs] },
      charts.filter((g) => g.needs === needs).map((g) => h('option', { value: g.key, title: g.hint }, g.label)))));
  const hint = h('div.muted.small.graphic-hint');
  select.addEventListener('change', () => {
    const g = charts.find((x) => x.key === select.value);
    if (g) {
      insertAtCursor(textarea, `[[${g.key}]]`);
      hint.textContent = `Added "${g.label}": ${g.hint}. It's filled in with the client's details when the email is sent, and left out if they don't apply.`;
    }
    select.value = '';
  });
  const image = async () => {
    const dataUri = await pickImage();
    if (!dataUri) return;
    const r = await attempt(() => api('/templates/images', { method: 'POST', body: { image: dataUri } }), 'Image added');
    insertAtCursor(textarea, r.tag);
  };
  return h('div.graphics-toolbar.full',
    h('div.toolbar-row', select,
      h('button.secondary.small', { type: 'button', onclick: () => buttonDialog(textarea) }, '▭ Insert button'),
      h('button.secondary.small', { type: 'button', onclick: image }, '🖼 Insert image'),
      onPreview ? h('button.secondary.small', { type: 'button', onclick: onPreview }, '👁 Preview') : null),
    hint);
}
