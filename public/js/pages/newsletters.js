// Monthly client newsletter: written by AI from the month's news on the
// chosen day, reviewed and edited here, then sent to clients (each with
// their own rate comparison).
import { api, h, pageHeader, table, badge, date, dateTime, attempt, toast, modal, confirmDialog, state, field, readForm } from '../core.js';
import { newsletterTabs } from './partnerNewsletters.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const STATUS = { generating: ['being written…', 'info'], ready: ['ready to review', 'warn'], failed: ['failed', 'danger'], sent: ['sent', 'ok'] };
const status = (s) => badge(...(STATUS[s] || [s, '']));
const RATES = [['owner_occupier_variable', 'Owner-occupier variable'], ['investor_variable', 'Investor variable'], ['owner_occupier_fixed', 'Owner-occupier fixed'], ['investor_fixed', 'Investor fixed']];
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;

function settingsDialog(data) {
  const s = data.settings;
  const fields = [
    { name: 'enabled', label: 'Write the newsletter automatically each month', type: 'checkbox', full: true },
    { name: 'day', label: 'Day of the month to write it (1–28)', type: 'number', step: 1 },
    { name: 'booking_url', label: 'Booking link (used when a broker hasn\'t connected Calendly)', placeholder: 'https://…' },
    { name: 'sources', label: 'Preferred news sources (one website per line)', type: 'textarea', rows: 7, full: true },
  ];
  const audience = h('fieldset.full.nl-checks', h('legend', 'Send to'),
    [['client', 'Clients'], ['past_client', 'Past clients'], ['prospect', 'Prospects']].map(([v, l]) => h('label.check-pill', h('input', { type: 'checkbox', name: 'audience', value: v, checked: s.audience.includes(v) }), l)));
  const reviewers = h('fieldset.full.nl-checks', h('legend', 'Email these people when it\'s ready to review (none ticked = all admins)'),
    (data.users || []).map((u) => h('label.check-pill', h('input', { type: 'checkbox', name: 'reviewers', value: u.id, checked: s.reviewers.includes(u.id) && s.reviewers.length !== (data.users || []).filter((x) => x.role === 'admin').length }), u.name)));
  const form = h('form.grid-form', fields.map((f) => field(f, f.name === 'sources' ? s.sources.join('\n') : f.name === 'enabled' ? (s.enabled ? 1 : 0) : s[f.name])), audience, reviewers,
    h('p.small.muted.full', 'Only clients who haven\'t opted out of marketing, with an email address, receive it. Each email address gets one copy.'),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Save')));
  const d = modal('Newsletter settings', form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    const body = {
      enabled: Boolean(v.enabled), day: v.day, booking_url: v.booking_url || '', sources: v.sources || '',
      audience: [...form.querySelectorAll('input[name=audience]:checked')].map((i) => i.value),
      reviewers: [...form.querySelectorAll('input[name=reviewers]:checked')].map((i) => Number(i.value)),
    };
    if (await attempt(() => api('/newsletters/settings', { method: 'PUT', body }), 'Saved')) { d.close(); refresh(); }
  });
}

export async function newslettersPage() {
  const data = await api('/newsletters');
  const s = data.settings;
  const isAdmin = state.user.role === 'admin';
  const thisMonth = data.rows.find((r) => r.month === data.current_month);
  const generate = async () => {
    const r = await attempt(() => api('/newsletters/generate', { method: 'POST', body: {} }));
    if (r) location.hash = `#/newsletters/${r.id}`;
  };
  return h('div',
    pageHeader('Newsletter',
      isAdmin ? h('button.secondary', { type: 'button', onclick: () => settingsDialog(data) }, 'Settings') : null,
      !thisMonth && data.ai_configured ? h('button', { type: 'button', onclick: generate }, `Write the ${data.current_month_label} newsletter now`) : null),
    newsletterTabs('clients'),
    !s.booking_ready ? h('div.alert.warn-box', h('strong', 'No booking link yet. '), 'The "Book a meeting with me" button needs one: connect Calendly in Settings, or add a booking link in Newsletter settings.') : null,
    !data.ai_configured ? h('div.alert.warn-box', h('strong', 'AI isn\'t set up yet. '), 'An admin needs to add an Anthropic API key in Settings → AI document reading. The newsletter is written with it.') : null,
    h('section.card.nl-summary',
      h('div', h('strong', s.enabled ? `Written automatically on the ${ordinal(s.day)} of each month` : 'Automatic writing is off'),
        h('p.small.muted', `Claude researches the month's banking, finance and property news (from ${s.sources.slice(0, 4).join(', ')}${s.sources.length > 4 ? ` and ${s.sources.length - 4} more` : ''}) and writes the newsletter. You get an email to review it, and nothing goes to clients until you press Send. It goes to ${data.recipients_count} client${data.recipients_count === 1 ? '' : 's'}, each with their own rate comparison.`))),
    h('section.card', h('h2', 'Newsletters'),
      table([
        { label: 'Month', value: (r) => h('a', { href: `#/newsletters/${r.id}` }, r.month_label) },
        { label: 'Headline', value: (r) => r.headline || h('span.muted', r.error || '—') },
        { label: 'Status', value: (r) => status(r.status) },
        { label: 'Sent', value: (r) => (r.sent_at ? `${date(r.sent_at)} · ${r.sent_count} clients` : '—') },
      ], data.rows, { onRow: (r) => { location.hash = `#/newsletters/${r.id}`; }, empty: 'No newsletters yet.' })));
}

// ---- Editor ---------------------------------------------------------------------------

function contentEditor(c, onChange) {
  const x = structuredClone(c);
  const changed = () => onChange(x);
  const inp = (obj, key, attrs = {}) => {
    const el = attrs.rows ? h('textarea', { rows: attrs.rows, 'aria-label': attrs.label }, obj[key] ?? '')
      : h('input', { type: attrs.type || 'text', value: obj[key] ?? '', step: attrs.step, 'aria-label': attrs.label, placeholder: attrs.placeholder || '' });
    el.addEventListener('input', () => { obj[key] = attrs.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value; changed(); });
    return attrs.bare ? el : h(`div.field${attrs.full ? '.full' : ''}`, h('label', attrs.label), el);
  };
  const root = h('div.nl-editor');
  const draw = () => {
    root.replaceChildren(...[
      h('div.grid-form',
        inp(x, 'subject', { label: 'Email subject', full: true }),
        inp(x, 'preheader', { label: 'Inbox preview line', full: true }),
        inp(x, 'headline', { label: 'Headline', full: true }),
        inp(x, 'intro', { label: 'Introduction', rows: 5, full: true })),
      h('h3', 'Key numbers'),
      h('div.nl-rows', x.key_numbers.map((k, i) => h('div.nl-row',
        inp(k, 'label', { label: 'Label', bare: true, placeholder: 'Label' }), inp(k, 'value', { label: 'Value', bare: true, placeholder: 'Value' }), inp(k, 'note', { label: 'Note', bare: true, placeholder: 'Note' }),
        h('button.icon.small', { type: 'button', 'aria-label': 'Remove', onclick: () => { x.key_numbers.splice(i, 1); changed(); draw(); } }, '×')))),
      x.key_numbers.length < 4 ? h('button.link.small', { type: 'button', onclick: () => { x.key_numbers.push({ label: '', value: '', note: '' }); draw(); } }, '+ Add a number') : null,
      h('h3', 'Average rates (for each client\'s rate comparison)'),
      h('div.grid-form.nl-rates',
        RATES.map(([k, l]) => inp(x.market_rates, k, { label: `${l} (%)`, type: 'number', step: '0.01' })),
        inp(x.market_rates, 'as_at', { label: 'As at' }), inp(x.market_rates, 'source_name', { label: 'Source' }), inp(x.market_rates, 'source_url', { label: 'Source link', full: true })),
      h('h3', 'Sections'),
      x.sections.map((sec, i) => h('fieldset.nl-section',
        h('legend', `Section ${i + 1}`, h('button.link.small', { type: 'button', onclick: () => { x.sections.splice(i, 1); changed(); draw(); } }, ' Remove')),
        h('div.grid-form', inp(sec, 'title', { label: 'Title', full: true }), inp(sec, 'body', { label: 'Text (start lines with "- " for bullets)', rows: 6, full: true })),
        sec.chart ? h('div.nl-chart',
          h('div.nl-row', inp(sec.chart, 'title', { label: 'Chart title', bare: true, placeholder: 'Chart title' }),
            (() => { const sel = h('select', { 'aria-label': 'Unit' }, [['%', '%'], ['$', '$'], ['number', 'Number']].map(([v, l]) => h('option', { value: v, selected: sec.chart.unit === v }, l))); sel.addEventListener('change', () => { sec.chart.unit = sel.value; changed(); }); return sel; })(),
            h('button.link.small', { type: 'button', onclick: () => { sec.chart = null; changed(); draw(); } }, 'Remove chart')),
          sec.chart.items.map((it, j) => h('div.nl-row', inp(it, 'label', { label: 'Label', bare: true }), inp(it, 'value', { label: 'Value', type: 'number', step: 'any', bare: true }),
            h('button.icon.small', { type: 'button', 'aria-label': 'Remove bar', onclick: () => { sec.chart.items.splice(j, 1); changed(); draw(); } }, '×'))),
          h('button.link.small', { type: 'button', onclick: () => { sec.chart.items.push({ label: '', value: 0 }); draw(); } }, '+ Add a bar'))
          : h('button.link.small', { type: 'button', onclick: () => { sec.chart = { title: '', unit: '%', items: [{ label: '', value: 0 }, { label: '', value: 0 }] }; draw(); } }, '+ Add a bar chart'),
        sec.sources.length ? h('div.small.nl-sources', 'Sources: ', sec.sources.map((src, j) => h('span',
          h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.publisher || src.title),
          h('button.link.small', { type: 'button', 'aria-label': 'Remove source', onclick: () => { sec.sources.splice(j, 1); changed(); draw(); } }, '×'), ' '))) : null)),
      h('button.link.small', { type: 'button', onclick: () => { x.sections.push({ title: '', body: '', chart: null, sources: [] }); draw(); } }, '+ Add a section')].flat().filter(Boolean));
  };
  draw();
  return { el: root, value: () => x };
}

function sendDialog(n) {
  const list = h('div.nl-recipients', h('p.muted', 'Loading…'));
  const count = h('strong');
  const form = h('form',
    h('p', 'The newsletter goes to every client below, each with their own rate comparison, from their broker\'s mailbox. Untick anyone who shouldn\'t get it this month.'),
    list,
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Send to ', count)));
  const d = modal(`Send the ${n.month_label} newsletter`, form, { wide: true });
  api('/newsletters/recipients').then(({ rows }) => {
    const update = () => { count.textContent = `${form.querySelectorAll('input[name=r]:checked').length} clients`; };
    list.replaceChildren(...rows.map((r) => h('label.nl-recipient', h('input', { type: 'checkbox', name: 'r', value: r.id, checked: true }),
      h('span', h('strong', r.name), ' ', h('span.muted.small', r.email)), r.loans ? badge(`${r.loans} loan${r.loans === 1 ? '' : 's'} compared`, 'info') : h('span.muted.small', 'market rates only'))));
    list.addEventListener('change', update);
    update();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const exclude = [...form.querySelectorAll('input[name=r]:not(:checked)')].map((i) => Number(i.value));
    const picked = form.querySelectorAll('input[name=r]:checked').length;
    if (!(await confirmDialog(`Send the newsletter to ${picked} client${picked === 1 ? '' : 's'} now? This can't be undone.`))) return;
    const r = await attempt(() => api(`/newsletters/${n.id}/send`, { method: 'POST', body: { exclude } }));
    if (r) { toast(`Sending to ${r.sent_count} clients`); d.close(); refresh(); }
  });
}

let pollTimer = null;
export async function newsletterPage(id) {
  clearTimeout(pollTimer);
  const n = await api(`/newsletters/${id}`);
  const isAdmin = state.user.role === 'admin';
  if (n.status === 'generating') {
    pollTimer = setTimeout(() => { if (location.hash === `#/newsletters/${id}`) refresh(); }, 8000);
    return h('div', pageHeader(`${n.month_label} newsletter`, h('a.button.secondary', { href: '#/newsletters' }, 'All newsletters')),
      h('section.card.nl-writing', h('div.nl-spinner', { 'aria-hidden': 'true' }), h('h2', 'Writing your newsletter…'),
        h('p.muted', 'Claude is researching this month\'s banking, finance and property news and writing the newsletter. This usually takes a few minutes. You can leave this page; you\'ll get an email when it\'s ready.')));
  }
  const regenerate = async () => {
    if (n.content && !(await confirmDialog('Write this newsletter again from scratch? Your edits will be replaced.'))) return;
    if (await attempt(() => api('/newsletters/generate', { method: 'POST', body: { month: n.month, regenerate: true } }))) refresh();
  };
  const remove = async () => {
    if (!(await confirmDialog('Delete this newsletter?'))) return;
    if (await attempt(() => api(`/newsletters/${n.id}`, { method: 'DELETE' }), 'Deleted')) location.hash = '#/newsletters';
  };
  const header = pageHeader(`${n.month_label} newsletter`, status(n.status), h('a.button.secondary', { href: '#/newsletters' }, 'All newsletters'));
  if (!n.content) {
    return h('div', header, h('section.card', h('div.alert.danger', n.error || 'This newsletter couldn\'t be written.'),
      h('div.actions', h('button', { type: 'button', onclick: regenerate }, 'Try again'), h('button.secondary', { type: 'button', onclick: remove }, 'Delete'))));
  }

  const sent = n.status === 'sent';
  let dirty = false;
  const saveBtn = h('button', { type: 'button', disabled: true }, 'Save changes');
  const editor = contentEditor(n.content, () => { dirty = true; saveBtn.disabled = false; });
  const frame = h('iframe.nl-frame', { title: 'Newsletter preview', sandbox: 'allow-same-origin allow-popups' });
  const who = h('select', { 'aria-label': 'Preview as' }, h('option', { value: '' }, 'Example (no loans on file)'));
  const reload = () => { frame.src = `/api/newsletters/${n.id}/preview?contact_id=${who.value}&t=${Date.now()}`; };
  who.addEventListener('change', reload);
  api('/newsletters/recipients').then(({ rows }) => {
    who.append(...rows.map((r) => h('option', { value: r.id }, `${r.name}${r.loans ? ` (${r.loans} loan${r.loans === 1 ? '' : 's'})` : ''}`)));
    const firstWithLoans = rows.find((r) => r.loans);
    if (firstWithLoans) who.value = String(firstWithLoans.id);
    reload();
  });
  const save = async () => {
    const r = await attempt(() => api(`/newsletters/${n.id}`, { method: 'PUT', body: { content: editor.value() } }), 'Saved');
    if (r) { dirty = false; saveBtn.disabled = true; reload(); }
    return r;
  };
  saveBtn.addEventListener('click', save);
  const test = async () => {
    if (dirty && !(await save())) return;
    const r = await attempt(() => api(`/newsletters/${n.id}/test`, { method: 'POST', body: {} }));
    if (r) toast(r.status === 'logged' ? `Test logged (no mailbox connected), to ${r.to}` : `Test sent to ${r.to}${r.sample ? ` (rates shown for ${r.sample})` : ''}`);
  };
  const send = async () => {
    if (dirty && !(await save())) return;
    sendDialog(n);
  };

  return h('div', header,
    n.error ? h('div.alert.warn-box', 'The last attempt to rewrite it failed: ', n.error) : null,
    sent ? h('div.alert.info', h('strong', `Sent ${dateTime(n.sent_at)} to ${n.sent_count} clients`), n.sent_by_name ? ` by ${n.sent_by_name}` : '',
      `. ${Object.entries(n.stats).map(([k, v]) => `${v} ${k}`).join(', ')}.`) : null,
    !sent && !n.booking_ready ? h('div.alert.warn-box', h('strong', 'No booking link yet, so the "Book a meeting with me" button is left out. '), 'Connect Calendly in Settings, or add a booking link in Newsletter settings.') : null,
    !sent && n.content.notes_for_broker.length ? h('div.alert.warn-box', h('strong', 'Please check before sending:'), h('ul', n.content.notes_for_broker.map((x) => h('li', x)))) : null,
    h('div.nl-layout',
      h('section.card.nl-edit',
        h('div.card-head', h('h2', sent ? 'Content (sent)' : 'Edit'), n.generated_at ? h('span.small.muted', `Written ${dateTime(n.generated_at)}${n.edited_by_name ? ` · edited by ${n.edited_by_name}` : ''}`) : null),
        sent ? h('fieldset', { disabled: true }, editor.el) : editor.el,
        !sent ? h('div.nl-actions',
          saveBtn,
          h('button.secondary', { type: 'button', onclick: test }, 'Send a test to me'),
          h('button.nl-send', { type: 'button', onclick: send }, `Send to ${n.recipients_count} clients…`),
          h('span.spacer'),
          h('button.link.small', { type: 'button', onclick: regenerate }, 'Rewrite with AI'),
          isAdmin ? h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete') : null) : null),
      h('section.card.nl-preview',
        h('div.card-head', h('h2', 'Preview'), h('label.small', 'As ', who)),
        frame)));
}
