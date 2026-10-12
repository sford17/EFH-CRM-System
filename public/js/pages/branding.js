// Settings → Branding (logo, colours, email style) and My email signature,
// plus the email preview used across the app.
import { api, h, modal, attempt, toast, state } from '../core.js';

const readFile = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('Could not read that file'));
  r.readAsDataURL(file);
});

const pickImage = () => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif' });
  input.addEventListener('change', async () => resolve(input.files[0] ? await readFile(input.files[0]) : null));
  input.click();
});

// Shows a rendered email (template, or subject/body text) in a sandboxed frame.
export async function previewEmail(payload, title = 'Email preview') {
  const { url, subject, sample } = await attempt(() => api('/email-preview', { method: 'POST', body: payload }));
  modal(subject ? `Preview: ${subject}` : title, [
    sample ? h('p.muted.small', 'Shown with example figures. Each client gets their own details.') : null,
    h('iframe.email-frame', { src: url, sandbox: '', title: 'Email preview' }),
    h('p.muted.small', 'Charts are built into the email itself, so they show even when the client\'s email program blocks pictures. Logos and images are embedded, so clients see them without clicking "download images".'),
  ], { wide: true });
}

// Most common strong colours in an image, for colour suggestions.
function logoColours(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 120 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 200) continue;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max > 240 && min > 240) continue; // white
        if (max < 25) continue; // black
        if (max - min < 25 && max > 60) continue; // greys
        // Bucket similar shades, but report each bucket's true average colour.
        const key = [r, g, b].map((v) => Math.round(v / 32)).join(',');
        const bucket = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b;
        counts.set(key, bucket);
      }
      const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
      resolve([...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((c) => `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`));
    };
    img.onerror = () => resolve([]);
    img.src = src;
  });
}

function colourInput(name, value) {
  const picker = h('input', { type: 'color', value, 'aria-label': `${name} colour picker` });
  const text = h('input', { type: 'text', value, 'aria-label': `${name} colour code`, maxlength: 7 });
  picker.addEventListener('input', () => { text.value = picker.value; });
  text.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value; });
  return { el: h('div.colour-field', picker, text), get: () => text.value.trim(), set: (v) => { picker.value = v; text.value = v; } };
}

export async function brandingCard() {
  if (state.user.role !== 'admin') return null;
  const b = await api('/branding');
  const announce = (brand) => window.dispatchEvent(new CustomEvent('crm:branding', { detail: brand }));

  const primary = colourInput('Main', b.primary);
  const sidebar = colourInput('Sidebar', b.sidebar);
  const swatches = h('div.swatches');
  const logoBox = h('div.logo-box', b.logo ? h('img', { src: `${b.logo.url}?v=${b.version}`, alt: 'Current logo' }) : h('span.muted', 'No logo yet'));

  const suggest = async (url) => {
    const colours = await logoColours(url);
    swatches.replaceChildren(...(colours.length ? [h('span.muted.small', 'From your logo:'), ...colours.map((c) => h('button.swatch', {
      type: 'button', title: `Use ${c}`, 'aria-label': `Use ${c} as main colour`, style: { background: c }, onclick: () => primary.set(c),
    }))] : []));
  };
  if (b.logo) suggest(`${b.logo.url}?v=${b.version}`);

  const upload = async () => {
    const image = await pickImage();
    if (!image) return;
    const brand = await attempt(() => api('/branding/logo', { method: 'POST', body: { image } }), 'Logo uploaded');
    logoBox.replaceChildren(h('img', { src: `${brand.logo.url}?v=${brand.version}`, alt: 'Current logo' }));
    suggest(`${brand.logo.url}?v=${brand.version}`);
    announce(brand);
  };
  const removeLogo = async () => {
    const brand = await attempt(() => api('/branding/logo', { method: 'DELETE' }), 'Logo removed');
    logoBox.replaceChildren(h('span.muted', 'No logo yet'));
    swatches.replaceChildren();
    announce(brand);
  };

  const style = h('select', { 'aria-label': 'Email style' },
    h('option', { value: 'banner', selected: b.email_style === 'banner' }, 'Banner – logo on a band of your main colour, with a branded footer'),
    h('option', { value: 'branded', selected: b.email_style === 'branded' }, 'Classic – logo on white with a thin colour bar, and a branded footer'),
    h('option', { value: 'plain', selected: b.email_style === 'plain' }, 'Plain – looks like a normal email (signature only)'));
  const emailLogo = h('input', { type: 'checkbox', checked: b.email_logo });
  const footerDetails = h('input', { type: 'checkbox', checked: b.email_footer_details });
  const footerNote = h('textarea', { rows: 3, maxlength: 600, placeholder: 'e.g. General advice only. Credit Representative 123456 of Example Aggregator, ACL 654321.' }, b.email_footer || '');

  const save = async () => {
    const brand = await attempt(() => api('/branding', {
      method: 'PUT',
      body: { primary: primary.get(), sidebar: sidebar.get(), email_style: style.value, email_logo: emailLogo.checked, email_footer_details: footerDetails.checked, email_footer: footerNote.value },
    }), 'Branding saved');
    announce(brand);
  };
  const reset = async () => {
    primary.set('#1f5fbf');
    sidebar.set('#12213a');
    const brand = await attempt(() => api('/branding', { method: 'PUT', body: { primary: '', sidebar: '' } }), 'Default colours restored');
    announce(brand);
  };

  return h('section.card',
    h('h2', 'Branding'),
    h('div.brand-row', logoBox,
      h('div.actions',
        h('button.secondary', { type: 'button', onclick: upload }, b.logo ? 'Change logo' : 'Upload logo'),
        b.logo ? h('button.danger.ghost', { type: 'button', onclick: removeLogo }, 'Remove') : null,
        h('div.muted.small', 'PNG or JPG, up to 1 MB. A wide logo on a white or transparent background works best.'))),
    h('div.grid-form',
      h('div.field', h('span', 'Main colour (buttons, links, email accent)'), primary.el, swatches),
      h('div.field', h('span', 'Sidebar colour'), sidebar.el),
      h('div.field.full', h('span', 'Email style'), style),
      h('label.field.check.full', emailLogo, 'Show the logo at the top of emails (untick if your signature already has it)'),
      h('label.field.check.full', footerDetails, 'Show your business name, phone, email, website and ACL number in the email footer (from Settings → Business)'),
      h('label.field.full', h('span', 'Footer note (optional, e.g. a disclaimer)'), footerNote)),
    h('p.muted.small', 'Colours are adjusted automatically where needed so text stays readable, including in dark mode.'),
    h('div.actions',
      h('button.secondary', { type: 'button', onclick: async () => { await save(); previewEmail({}); } }, 'Save & preview an email'),
      h('button.secondary', { type: 'button', onclick: reset }, 'Reset colours'),
      h('button', { type: 'button', onclick: save }, 'Save branding')));
}

export async function signatureCard() {
  const { html } = await api('/signature');
  const editor = h('div.signature-editor', { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Email signature', 'data-placeholder': 'Paste your signature here…' });
  editor.innerHTML = html; // already cleaned by the server
  const frame = h('iframe.email-frame', { sandbox: '', title: 'Signature preview', hidden: true });

  const refreshPreview = async () => {
    const { url } = await api('/email-preview', { method: 'POST', body: {} });
    frame.src = url;
    frame.hidden = false;
  };
  const insertImage = async () => {
    const image = await pickImage();
    if (!image) return;
    const { url } = await attempt(() => api('/signature/image', { method: 'POST', body: { image } }));
    editor.focus();
    document.execCommand('insertImage', false, url);
  };
  const save = async () => {
    const r = await attempt(() => api('/signature', { method: 'PUT', body: { html: editor.innerHTML } }));
    editor.innerHTML = r.html;
    if (r.removed_images) {
      toast(`Saved, but ${r.removed_images} image(s) couldn't be copied from Outlook. Use "Insert image" to add them.`, 'error');
    } else {
      toast('Signature saved');
    }
    refreshPreview();
  };
  const clearSig = async () => {
    editor.innerHTML = '';
    await attempt(() => api('/signature', { method: 'PUT', body: { html: '' } }), 'Signature cleared – your name, business and phone will be used');
    refreshPreview();
  };

  return h('section.card',
    h('h2', 'My email signature'),
    h('p.muted.small', 'Added to the bottom of every email you send from the CRM, including automated ones. Outlook doesn\'t let other apps read your signature, so copy it in once:'),
    h('ol.setup-steps',
      h('li', h('strong', 'Outlook on the web:'), ' Settings ⚙ → Mail → Compose and reply → select your signature text in the box → Ctrl+C.'),
      h('li', h('strong', 'Outlook desktop:'), ' start a new email so your signature appears, select it all → Ctrl+C.'),
      h('li', 'Click in the box below and press Ctrl+V, then Save. If your logo or other pictures don\'t come across, click ', h('strong', 'Insert image'), ' to add them.')),
    editor,
    h('div.actions',
      h('button.secondary', { type: 'button', onclick: insertImage }, 'Insert image'),
      h('button.secondary', { type: 'button', onclick: clearSig }, 'Clear'),
      h('button.secondary', { type: 'button', onclick: refreshPreview }, 'Preview'),
      h('button', { type: 'button', onclick: save }, 'Save signature')),
    frame);
}
