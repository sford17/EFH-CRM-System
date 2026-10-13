// Monthly referral partner newsletter: a client story the broker writes (AI
// can tidy it up) and industry updates researched by AI on the chosen day.
import { api, h, pageHeader, table, badge, date, dateTime, attempt, toast, modal, confirmDialog, state, field, readForm } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const STATUS = { draft: ['story only', 'info'], generating: ['being written…', 'info'], ready: ['ready to review', 'warn'], failed: ['failed', 'danger'], sent: ['sent', 'ok'] };
const status = (s) => badge(...(STATUS[s] || [s, '']));
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][(n % 100 >> 3) ^ 1 && n % 10] || 'th'}`;

// Tabs shared with the client newsletter page.
export const newsletterTabs = (active) => h('nav.tabs', { 'aria-label': 'Newsletters' },
  h(`a${active === 'clients' ? '.active' : ''}`, { href: '#/newsletters', 'aria-current': active === 'clients' ? 'page' : undefined }, 'Clients'),
  h(`a${active === 'partners' ? '.active' : ''}`, { href: '#/partner-newsletters', 'aria-current': active === 'partners' ? 'page' : undefined }, 'Referral partners'));

function settingsDialog(data) {
  const s = data.settings;
  const fields = [
    { name: 'enabled', label: 'Write the partner newsletter automatically each month', type: 'checkbox', full: true },
    { name: 'day', label: 'Day of the month to write it (1–28)', type: 'number', step: 1 },
  ];
  const types = h('fieldset.full.nl-checks', h('legend', 'Send to'),
    data.types.map(([v, l]) => h('label.check-pill', h('input', { type: 'checkbox', name: 'types', value: v, checked: s.types.includes(v) }), l)));
  const form = h('form.grid-form', fields.map((f) => field(f, f.name === 'enabled' ? (s.enabled ? 1 : 0) : s[f.name])), types,
    h('p.small.muted.full', 'Active partners with an email address who haven\'t unsubscribed receive it (switch it off for anyone on the Partners & agents page). You get a reminder a few days before to add a client story, then an email when it\'s ready. The people emailed, the news sources and the booking link are shared with the client newsletter settings.'),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Save')));
  const d = modal('Partner newsletter settings', form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readForm(form, fields);
    const body = { enabled: Boolean(v.enabled), day: v.day, types: [...form.querySelectorAll('input[name=types]:checked')].map((i) => i.value) };
    try {
      await attempt(() => api('/partner-newsletters/settings', { method: 'PUT', body }), 'Saved');
      d.close();
      refresh();
    } catch { /* toasted */ }
  });
}

export async function partnerNewslettersPage() {
  const data = await api('/partner-newsletters');
  const s = data.settings;
  const isAdmin = state.user.role === 'admin';
  const thisMonth = data.rows.find((r) => r.month === data.current_month);
  const open = async (path, body = {}) => {
    try {
      const r = await attempt(() => api(`/partner-newsletters/${path}`, { method: 'POST', body }));
      location.hash = `#/partner-newsletters/${r.id}`;
    } catch { /* toasted */ }
  };
  return h('div',
    pageHeader('Newsletter',
      isAdmin ? h('button.secondary', { type: 'button', onclick: () => settingsDialog(data) }, 'Settings') : null,
      !thisMonth ? h('button.secondary', { type: 'button', onclick: () => open('draft') }, `Write the ${data.current_month_label} client story`) : null,
      !thisMonth || thisMonth.status === 'draft' ? h('button', { type: 'button', onclick: () => open('generate') }, `Write the ${data.current_month_label} newsletter now`) : null),
    newsletterTabs('partners'),
    !data.ai_configured ? h('div.alert.warn-box', h('strong', 'AI isn\'t set up yet. '), 'The newsletter will still be started each month for you to write by hand. Add an Anthropic API key in Settings → AI for the industry updates to be researched and written for you.') : null,
    !data.recipients_count ? h('div.alert.warn-box', h('strong', 'No partners to send to yet. '), 'Add email addresses to your referral partners on the ', h('a', { href: '#/partners' }, 'Partners & agents'), ' page.') : null,
    h('section.card.nl-summary',
      h('div', h('strong', s.enabled ? `Written automatically on the ${ordinal(s.day)} of each month` : 'Automatic writing is off'),
        h('p.small.muted', `Each month: a client story you write (a few sentences is enough – AI can tidy it up and keep it anonymous) and industry updates that Claude researches, each with what it means for your partners' clients. You get a reminder ${s.day > 3 ? `on the ${ordinal(s.day - 3)} ` : ''}to add the story, and an email on the ${ordinal(s.day)} when it's ready to review. It goes to ${data.recipients_count} referral partner${data.recipients_count === 1 ? '' : 's'}, from your mailbox, with a "Refer a client" button.`))),
    h('section.card', h('h2', 'Partner newsletters'),
      table([
        { label: 'Month', value: (r) => h('a', { href: `#/partner-newsletters/${r.id}` }, r.month_label) },
        { label: 'Headline', value: (r) => r.headline || h('span.muted', r.status === 'draft' ? (r.has_story ? 'Client story written' : 'Not started') : r.error || '—') },
        { label: 'Client story', value: (r) => (r.has_story ? '✓' : h('span.text-warn', 'Needed')) },
        { label: 'Status', value: (r) => status(r.status) },
        { label: 'Sent', value: (r) => (r.sent_at ? `${date(r.sent_at)} · ${r.sent_count} partners` : '—') },
      ], data.rows, { onRow: (r) => { location.hash = `#/partner-newsletters/${r.id}`; }, empty: 'No partner newsletters yet.' })));
}

// ---- The client story -------------------------------------------------------------------------------------

function storyEditor(n, x, onChange) {
  const story = x ? x.scenario : null;
  const notes = h('textarea', { rows: 6, 'aria-label': 'Your notes about the client', placeholder: 'e.g. Young couple renting in Parramatta, both nurses, one on a temporary visa. Thought they needed 20% deposit. We used the First Home Guarantee: bought a $780k unit with 5% down, no LMI, approved in 6 days with ING. Referred by Jane at Harbour Realty.' });
  notes.value = n.scenario_notes || '';
  notes.addEventListener('input', () => onChange({ notes: notes.value }));
  const box = h('div.pn-story');
  const tidy = h('button.secondary.small', { type: 'button' }, '✨ Tidy up with AI');
  tidy.addEventListener('click', async () => {
    tidy.disabled = true;
    tidy.textContent = 'Writing…';
    try {
      const r = await attempt(() => api('/partner-newsletters/polish', { method: 'POST', body: { notes: notes.value } }));
      if (story) {
        Object.assign(story, r);
        onChange({ notes: notes.value, story: true });
        drawStory();
      } else {
        modal('Your client story', [h('h3', r.title), h('p.pre', r.body), h('p.small.muted', 'It\'ll be used when the newsletter is written. Save your notes to keep them.')]);
      }
    } catch { /* toasted */ } finally {
      tidy.disabled = false;
      tidy.textContent = '✨ Tidy up with AI';
    }
  });
  const inp = (obj, key, attrs = {}) => {
    const el = attrs.rows ? h('textarea', { rows: attrs.rows, 'aria-label': attrs.label }) : h('input', { type: 'text', 'aria-label': attrs.label, placeholder: attrs.placeholder || '' });
    el.value = obj[key] ?? '';
    el.addEventListener('input', () => { obj[key] = el.value; onChange({ story: true }); });
    return attrs.bare ? el : h(`div.field${attrs.full ? '.full' : ''}`, h('label', attrs.label), el);
  };
  const drawStory = () => {
    if (!story) return;
    box.replaceChildren(
      h('div.grid-form', inp(story, 'title', { label: 'Story headline', full: true }), inp(story, 'body', { label: 'The story (as it appears in the email)', rows: 8, full: true })),
      h('div.small.muted', 'Highlights (optional, shown as tiles):'),
      h('div.nl-rows', story.highlights.map((k, i) => h('div.nl-row', inp(k, 'label', { bare: true, label: 'Label', placeholder: 'e.g. Deposit' }), inp(k, 'value', { bare: true, label: 'Value', placeholder: 'e.g. 5%' }),
        h('button.icon.small', { type: 'button', 'aria-label': 'Remove', onclick: () => { story.highlights.splice(i, 1); onChange({ story: true }); drawStory(); } }, '×')))),
      story.highlights.length < 4 ? h('button.link.small', { type: 'button', onclick: () => { story.highlights.push({ label: '', value: '' }); drawStory(); } }, '+ Add a highlight') : null);
  };
  drawStory();
  const ideas = h('details.pn-ideas', h('summary', 'Ideas from your recent settlements'), h('p.small.muted', 'Loading…'));
  ideas.addEventListener('toggle', async () => {
    if (!ideas.open || ideas.dataset.loaded) return;
    ideas.dataset.loaded = '1';
    const { rows } = await api('/partner-newsletters/ideas');
    ideas.replaceChildren(h('summary', 'Ideas from your recent settlements'),
      rows.length ? h('ul.plain', rows.map((r) => h('li', h('span', r.label, r.referred_by ? h('span.muted.small', ` · referred by ${r.referred_by}`) : null), ' ',
        h('button.link.small', { type: 'button', onclick: () => { notes.value = `${notes.value ? `${notes.value}\n\n` : ''}${r.notes}`; onChange({ notes: notes.value }); notes.focus(); } }, 'Use as a starting point'))))
        : h('p.small.muted', 'No settled deals yet.'),
      h('p.small.muted', 'Starting points leave out names and addresses. Fill in the challenge, what you did and the result.'));
  });
  return h('section.card',
    h('h2', 'Client story'),
    h('p.small.muted', 'Describe a client you\'ve helped recently: their situation, the challenge, what you did and the result. Write it however you like – then use it as is, or let AI tidy it into a short, anonymous story. Leave out names and anything that could identify them (or check they\'re happy to be featured).'),
    h('div.field', h('label', 'Your notes'), notes),
    h('div.actions.pn-actions', tidy, ideas),
    story ? box : null);
}

// ---- Editing the rest ------------------------------------------------------------------------------------

function updatesEditor(x, onChange) {
  const changed = () => onChange({ content: true });
  const inp = (obj, key, attrs = {}) => {
    const el = attrs.rows ? h('textarea', { rows: attrs.rows, 'aria-label': attrs.label }) : h('input', { type: 'text', 'aria-label': attrs.label, placeholder: attrs.placeholder || '' });
    el.value = obj[key] ?? '';
    el.addEventListener('input', () => { obj[key] = el.value; changed(); });
    return attrs.bare ? el : h(`div.field${attrs.full ? '.full' : ''}`, h('label', attrs.label), el);
  };
  const root = h('div.nl-editor');
  const draw = () => {
    root.replaceChildren(...[
      h('div.grid-form',
        inp(x, 'subject', { label: 'Email subject', full: true }),
        inp(x, 'preheader', { label: 'Inbox preview line', full: true }),
        inp(x, 'headline', { label: 'Headline', full: true }),
        inp(x, 'intro', { label: 'Introduction', rows: 4, full: true })),
      h('h3', 'Key numbers'),
      h('div.nl-rows', x.key_numbers.map((k, i) => h('div.nl-row', inp(k, 'label', { bare: true, label: 'Label', placeholder: 'Label' }), inp(k, 'value', { bare: true, label: 'Value', placeholder: 'Value' }), inp(k, 'note', { bare: true, label: 'Note', placeholder: 'Note' }),
        h('button.icon.small', { type: 'button', 'aria-label': 'Remove', onclick: () => { x.key_numbers.splice(i, 1); changed(); draw(); } }, '×')))),
      x.key_numbers.length < 4 ? h('button.link.small', { type: 'button', onclick: () => { x.key_numbers.push({ label: '', value: '', note: '' }); draw(); } }, '+ Add a number') : null,
      h('h3', 'Industry updates'),
      x.updates.map((u, i) => h('fieldset.nl-section',
        h('legend', `Update ${i + 1}`, h('button.link.small', { type: 'button', onclick: () => { x.updates.splice(i, 1); changed(); draw(); } }, ' Remove')),
        h('div.grid-form',
          inp(u, 'title', { label: 'Title', full: true }),
          inp(u, 'body', { label: 'Text (start lines with "- " for bullets)', rows: 5, full: true }),
          inp(u, 'for_clients', { label: 'What it means for their clients', rows: 2, full: true })),
        u.chart ? h('p.small.muted', `Chart: ${u.chart.title} `, h('button.link.small', { type: 'button', onclick: () => { u.chart = null; changed(); draw(); } }, 'Remove chart')) : null,
        u.sources.length ? h('div.small.nl-sources', 'Sources: ', u.sources.map((src, j) => h('span', h('a', { href: src.url, target: '_blank', rel: 'noopener noreferrer' }, src.publisher || src.title),
          h('button.link.small', { type: 'button', 'aria-label': 'Remove source', onclick: () => { u.sources.splice(j, 1); changed(); draw(); } }, '×'), ' '))) : null)),
      h('button.link.small', { type: 'button', onclick: () => { x.updates.push({ title: '', body: '', for_clients: '', chart: null, sources: [] }); draw(); } }, '+ Add an update'),
      h('h3', 'Closing ("Know someone we could help?")'),
      inp(x, 'closing', { label: 'Closing', rows: 3, bare: true }),
      h('p.small.muted', 'A "Refer a client" button (an email to you) and a link to book a catch-up are added underneath.')].flat().filter(Boolean));
  };
  draw();
  return root;
}

function sendDialog(n) {
  const list = h('div.nl-recipients', h('p.muted', 'Loading…'));
  const count = h('strong');
  const form = h('form',
    h('p', 'It goes to each partner below from your mailbox, addressed to them by first name. Untick anyone who shouldn\'t get it this month.'),
    list,
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Send to ', count)));
  const d = modal(`Send the ${n.month_label} partner newsletter`, form, { wide: true });
  api('/partner-newsletters/recipients').then(({ rows }) => {
    const update = () => { count.textContent = `${form.querySelectorAll('input[name=r]:checked').length} partners`; };
    list.replaceChildren(...rows.map((r) => h('label.nl-recipient', h('input', { type: 'checkbox', name: 'r', value: r.id, checked: true }),
      h('span', h('strong', r.name), r.company ? ` · ${r.company}` : '', ' ', h('span.muted.small', r.email)), h('span.muted.small', r.type))));
    list.addEventListener('change', update);
    update();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const exclude = [...form.querySelectorAll('input[name=r]:not(:checked)')].map((i) => Number(i.value));
    const picked = form.querySelectorAll('input[name=r]:checked').length;
    if (!(await confirmDialog(`Send the partner newsletter to ${picked} partner${picked === 1 ? '' : 's'} now? This can't be undone.`))) return;
    try {
      const r = await attempt(() => api(`/partner-newsletters/${n.id}/send`, { method: 'POST', body: { exclude } }));
      toast(`Sending to ${r.sent_count} partners`);
      d.close();
      refresh();
    } catch { /* toasted */ }
  });
}

let pollTimer = null;
export async function partnerNewsletterPage(id) {
  clearTimeout(pollTimer);
  const n = await api(`/partner-newsletters/${id}`);
  const back = h('a.button.secondary', { href: '#/partner-newsletters' }, 'All partner newsletters');
  const title = `${n.month_label} partner newsletter`;
  if (n.status === 'generating') {
    pollTimer = setTimeout(() => { if (location.hash === `#/partner-newsletters/${id}`) refresh(); }, 8000);
    return h('div', pageHeader(title, back),
      h('section.card.nl-writing', h('div.nl-spinner', { 'aria-hidden': 'true' }), h('h2', 'Writing your partner newsletter…'),
        h('p.muted', 'Claude is researching this month\'s industry news (and writing up your client story, if you\'ve added one). This usually takes a few minutes. You\'ll get an email when it\'s ready.')));
  }
  const generate = async (regenerate) => {
    if (regenerate && !(await confirmDialog('Rewrite the industry updates (and the story from your notes)? Your edits to them will be replaced.'))) return;
    try {
      if (dirty) await saveAll();
      await attempt(() => api('/partner-newsletters/generate', { method: 'POST', body: { month: n.month, regenerate } }));
      refresh();
    } catch { /* toasted */ }
  };
  const remove = async () => {
    if (!(await confirmDialog('Delete this partner newsletter?'))) return;
    try {
      await attempt(() => api(`/partner-newsletters/${n.id}`, { method: 'DELETE' }), 'Deleted');
      location.hash = '#/partner-newsletters';
    } catch { /* toasted */ }
  };

  const sent = n.status === 'sent';
  const x = n.content ? structuredClone(n.content) : null;
  let notesValue = n.scenario_notes;
  let dirty = false;
  const saveBtn = h('button', { type: 'button', disabled: true }, 'Save changes');
  const onChange = (what) => {
    if (what.notes !== undefined) notesValue = what.notes;
    dirty = true;
    saveBtn.disabled = false;
  };
  const frame = x ? h('iframe.nl-frame', { title: 'Newsletter preview', sandbox: 'allow-same-origin allow-popups' }) : null;
  const reload = () => { if (frame) frame.src = `/api/partner-newsletters/${n.id}/preview?t=${Date.now()}`; };
  const saveAll = async () => {
    await api(`/partner-newsletters/${n.id}/notes`, { method: 'PUT', body: { notes: notesValue } });
    if (x) await api(`/partner-newsletters/${n.id}`, { method: 'PUT', body: { content: x } });
    dirty = false;
    saveBtn.disabled = true;
    reload();
  };
  saveBtn.addEventListener('click', async () => {
    try { await attempt(saveAll, 'Saved'); } catch { /* toasted */ }
  });
  const test = async () => {
    try {
      if (dirty) await saveAll();
      const r = await attempt(() => api(`/partner-newsletters/${n.id}/test`, { method: 'POST', body: {} }));
      toast(r.status === 'logged' ? `Test logged (no mailbox connected), to ${r.to}` : `Test sent to ${r.to}`);
    } catch { /* toasted */ }
  };
  const send = async () => {
    try {
      if (dirty) await attempt(saveAll);
      const fresh = await api(`/partner-newsletters/${n.id}`);
      if (fresh.missing?.length) { toast(`Add ${fresh.missing.join(' and ')} first`, 'error'); return; }
      sendDialog(n);
    } catch { /* toasted */ }
  };
  const story = storyEditor(n, x, onChange);

  if (!x) {
    // A draft: just the story for now; the updates are written on the day (or now).
    const saveNotes = h('button', { type: 'button' }, 'Save my notes');
    saveNotes.addEventListener('click', async () => {
      try {
        await attempt(() => api(`/partner-newsletters/${n.id}/notes`, { method: 'PUT', body: { notes: notesValue } }), 'Saved – it\'ll be used when the newsletter is written');
        dirty = false;
      } catch { /* toasted */ }
    });
    return h('div', pageHeader(title, status(n.status), back),
      n.status === 'failed' ? h('div.alert.danger', n.error || 'The newsletter couldn\'t be written.') : null,
      h('div.alert.info', 'Write this month\'s client story now. The industry updates are researched and added on the newsletter day, or press "Write the newsletter now".'),
      story,
      h('div.actions', saveNotes, h('button.secondary', { type: 'button', onclick: async () => { try { await attempt(() => api(`/partner-newsletters/${n.id}/notes`, { method: 'PUT', body: { notes: notesValue } })); } catch { return; } generate(false); } }, n.status === 'failed' ? 'Try again' : 'Write the newsletter now'),
        h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete')));
  }

  reload();
  return h('div',
    pageHeader(title, status(n.status), back),
    n.error ? h('div.alert.warn-box', n.error) : null,
    sent ? h('div.alert.info', h('strong', `Sent ${dateTime(n.sent_at)} to ${n.sent_count} partners`), n.sent_by_name ? ` by ${n.sent_by_name}` : '', `. ${Object.entries(n.stats).map(([k, v]) => `${v} ${k}`).join(', ')}.`) : null,
    !sent && n.missing?.length ? h('div.alert.warn-box', h('strong', 'Before sending: '), `add ${n.missing.join(' and ')}.`) : null,
    !sent && x.notes_for_broker.length ? h('div.alert.warn-box', h('strong', 'Please check before sending:'), h('ul', x.notes_for_broker.map((t) => h('li', t)))) : null,
    h('div.nl-layout',
      h('div',
        sent ? h('fieldset', { disabled: true }, story) : story,
        h('section.card.nl-edit',
          h('div.card-head', h('h2', sent ? 'Content (sent)' : 'Industry updates & the rest'), n.generated_at ? h('span.small.muted', `Written ${dateTime(n.generated_at)}${n.edited_by_name ? ` · edited by ${n.edited_by_name}` : ''}`) : null),
          sent ? h('fieldset', { disabled: true }, updatesEditor(x, onChange)) : updatesEditor(x, onChange),
          !sent ? h('div.nl-actions',
            saveBtn,
            h('button.secondary', { type: 'button', onclick: test }, 'Send a test to me'),
            h('button.nl-send', { type: 'button', onclick: send }, `Send to ${n.recipients_count} partners…`),
            h('span.spacer'),
            h('button.link.small', { type: 'button', onclick: () => generate(true) }, 'Rewrite with AI'),
            h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete')) : null)),
      h('section.card.nl-preview', h('div.card-head', h('h2', 'Preview'), h('span.small.muted', 'As "Sarah Example" sees it')), frame)));
}
