// Property reports: a client's valuation history (from the mortgage tracker)
// with AI-researched data on each property's area, sent as a branded email
// with a PDF. A card on the contact's tracker tab, and an editor page.
import { api, h, pageHeader, attempt, toast, confirmDialog, modal, badge, dateTime, money } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const statusBadge = (s) => (s === 'researching' ? badge('researching…', 'info') : s === 'failed' ? badge('failed', 'danger') : s === 'sent' ? badge('sent', 'ok') : badge('ready to review', 'warn'));

// ---- Card on the contact's tracker tab ----------------------------------------------------------------

function chooseProperties(contact, data) {
  const boxes = data.properties.map((p) => {
    const box = h('input', { type: 'checkbox', value: p.id, checked: p.ready, disabled: !p.ready });
    return h('label.nl-recipient', box,
      h('span', h('strong', p.address), h('div.small.muted',
        p.ready ? [`Area: ${p.suburb} ${p.state}`, `${p.valuations} valuation${p.valuations === 1 ? '' : 's'}`, p.current_value ? `now ${money(p.current_value)}` : null].filter(Boolean).join(' · ')
          : 'No suburb and state, so the area can\'t be researched. Edit the property to add them.')));
  });
  const go = h('button', { type: 'submit' }, '📈 Create report');
  const form = h('form',
    h('p.small.muted', 'Choose the properties to include. AI researches each area on the web (median prices, growth, rents, local news), which takes a few minutes. You can review and edit everything before it goes to the client.'),
    h('div.nl-recipients', boxes),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), go));
  const d = modal(`Property report for ${contact.first_name}`, form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => Number(b.value));
    if (!ids.length) { toast('Choose at least one property', 'error'); return; }
    go.disabled = true;
    const r = await attempt(() => api('/property-reports', { method: 'POST', body: { contact_id: contact.id, property_ids: ids } }));
    go.disabled = false;
    if (r) { d.close(); location.hash = `#/property-reports/${r.id}`; }
  });
}

export async function propertyReportsCard(contact) {
  const data = await api(`/property-reports/contact/${contact.id}`);
  if (!data.properties.length && !data.rows.length) return null;
  const start = () => {
    if (!data.configured) { toast('Property reports use AI. An admin needs to add an Anthropic API key in Settings → AI.', 'error'); return; }
    chooseProperties(contact, data);
  };
  return h('section.card.pr-card',
    h('div.card-head', h('h2', 'Property reports'),
      h('div.actions', h('button.small', { type: 'button', onclick: start }, '📈 Property report'))),
    h('p.small.muted', 'Send the client a report on how their properties have performed (valuation history, growth and equity), with the latest market data and news for their area.'),
    data.rows.length ? h('div.lg-history', data.rows.map((r) => h('a.lg-history-row', { href: `#/property-reports/${r.id}` },
      h('span', `${r.property_count} propert${r.property_count === 1 ? 'y' : 'ies'} · ${dateTime(r.created_at)}`),
      h('span.small', r.status === 'sent' ? h('span.muted', `Sent to ${r.sent_to} ${dateTime(r.sent_at)} `) : null, statusBadge(r.status)))))
      : null);
}

// ---- Editor page ------------------------------------------------------------------------------------

const area = (rows, value, attrs = {}) => {
  const t = h('textarea', { rows, ...attrs });
  t.value = value || '';
  return t;
};
const input = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });

function areaEditor(a, onChange) {
  const summary = area(5, a.summary, { 'aria-label': `Summary for ${a.suburb}` });
  const stats = a.stats.map((s) => ({ ...s }));
  const statRows = h('div.nl-rows');
  const drawStats = () => statRows.replaceChildren(...stats.map((s, i) => {
    const label = input(s.label, { 'aria-label': 'Measure', placeholder: 'Measure' });
    const value = input(s.value, { 'aria-label': 'Figure', placeholder: 'Figure' });
    const period = input(s.period, { 'aria-label': 'Period', placeholder: 'Period' });
    label.addEventListener('input', () => { s.label = label.value; onChange(); });
    value.addEventListener('input', () => { s.value = value.value; onChange(); });
    period.addEventListener('input', () => { s.period = period.value; onChange(); });
    return h('div.nl-row', label, value, period,
      s.source_url ? h('a.small', { href: s.source_url, target: '_blank', rel: 'noopener noreferrer', title: s.source_url }, s.source_name || 'source') : h('span.small.muted', s.source_name || ''),
      h('button.icon', { type: 'button', 'aria-label': 'Remove', onclick: () => { stats.splice(i, 1); drawStats(); onChange(); } }, '×'));
  }));
  drawStats();
  const highlights = area(4, a.highlights.join('\n'), { 'aria-label': `Local news for ${a.suburb}` });
  summary.addEventListener('input', onChange);
  highlights.addEventListener('input', onChange);
  const el = h('fieldset.nl-section',
    h('legend', `${a.suburb} ${a.state || ''} (${a.property_type === 'unit' ? 'units' : 'houses'})`),
    !a.summary && !a.stats.length ? h('p.small.text-warn', 'Nothing was found for this area. Write a summary yourself, or try "Refresh area data".') : null,
    h('label.field', h('span', 'Summary'), summary),
    h('div.field', h('span', 'Figures'), statRows),
    a.trend ? h('p.small.muted', `Chart: ${a.trend.title} (${a.trend.items.map((i) => i.label).join(', ')})`) : null,
    h('label.field', h('span', 'What\'s happening locally (one per line)'), highlights),
    a.sources.length ? h('div.small.nl-sources', 'Sources: ', a.sources.map((s, i) => [i ? ', ' : '', h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.publisher || s.title)])) : null);
  return {
    el,
    value: () => ({ key: a.key, summary: summary.value, stats: stats.filter((s) => s.label.trim() && s.value.trim()), trend: a.trend, highlights: highlights.value.split('\n').map((x) => x.trim()).filter(Boolean), sources: a.sources }),
  };
}

function emailDialog(r, onSent) {
  const to = h('input', { type: 'email', required: true, value: r.to || '', 'aria-label': 'To' });
  const subject = h('input', { type: 'text', required: true, value: r.content.title, 'aria-label': 'Subject' });
  const go = h('button', { type: 'submit' }, 'Send');
  const form = h('form.grid-form',
    h('label.field.full', h('span', 'To'), to),
    h('label.field.full', h('span', 'Subject'), subject),
    h('p.small.muted.full', `The report is the email itself (with charts), plus a PDF copy attached. It's sent from your connected mailbox with your signature.`),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), go));
  const d = modal('Email the property report', form, { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      const res = await api(`/property-reports/${r.id}/email`, { method: 'POST', body: { to: to.value, subject: subject.value } });
      toast(res.outbox.status === 'logged' ? 'Logged (no mailbox connected, so it wasn\'t actually emailed)' : `Property report sent to ${res.sent_to}`);
      d.close();
      onSent();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      go.disabled = false;
    }
  });
}

let poll = null;
export async function propertyReportPage(id) {
  clearTimeout(poll);
  const r = await api(`/property-reports/${id}`);
  const header = pageHeader(`Property report – ${r.contact_name}`, h('a.button.secondary', { href: `#/contacts/${r.contact_id}?tab=tracker` }, 'Back to client'));
  if (r.status === 'researching') {
    poll = setTimeout(() => { if (location.hash === `#/property-reports/${id}`) refresh(); }, 5000);
    return h('div', header, h('section.card.nl-writing', h('div.nl-spinner', { 'aria-hidden': 'true' }), h('h2', 'Researching the area…'),
      h('p.muted', 'AI is searching the web for market data and local news. This usually takes 2–5 minutes. You can leave this page; you\'ll get a notification when it\'s ready.')));
  }
  const c = r.content;
  let dirty = false;
  const saveBtn = h('button', { type: 'button', disabled: true }, 'Save changes');
  const changed = () => { dirty = true; saveBtn.disabled = false; };
  const title = input(c.title, { 'aria-label': 'Title' });
  const intro = area(5, c.intro, { 'aria-label': 'Introduction' });
  const closing = area(3, c.closing, { 'aria-label': 'Closing' });
  [title, intro, closing].forEach((el) => el.addEventListener('input', changed));
  const notes = c.properties.map((pp) => {
    const perf = r.performance.find((p) => p.id === pp.property_id);
    const t = area(4, pp.note, { 'aria-label': `Note for ${perf?.address || 'property'}` });
    t.addEventListener('input', changed);
    return { pp, perf, t };
  });
  const areas = c.areas.map((a) => areaEditor(a, changed));

  const frame = h('iframe.nl-frame', { title: 'Report preview', sandbox: 'allow-same-origin' });
  let view = 'email';
  const reload = () => { frame.src = `/api/property-reports/${id}/${view === 'email' ? 'email-preview' : 'preview'}?t=${Date.now()}`; };
  const tabs = h('div.pr-views', [['email', 'Email'], ['document', 'PDF document']].map(([k, l]) => {
    const b = h('button.small', { type: 'button', 'aria-pressed': String(k === view), onclick: () => {
      view = k;
      tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      reload();
    } }, l);
    return b;
  }));
  reload();

  const save = async () => {
    const body = {
      content: {
        title: title.value, intro: intro.value, closing: closing.value,
        properties: notes.map((n) => ({ property_id: n.pp.property_id, note: n.t.value })), areas: areas.map((a) => a.value()),
      },
    };
    const res = await attempt(() => api(`/property-reports/${id}`, { method: 'PUT', body }), 'Saved');
    if (res) { dirty = false; saveBtn.disabled = true; reload(); }
    return res;
  };
  saveBtn.addEventListener('click', save);
  const send = async () => {
    if (dirty && !(await save())) return;
    emailDialog(r, refresh);
  };
  const pdf = async () => {
    if (dirty && !(await save())) return;
    location.href = `/api/property-reports/${id}/pdf`;
  };
  const rerun = async () => {
    if (!(await confirmDialog('Research the areas again? This replaces the area summaries and figures (your intro, closing and property notes stay).'))) return;
    if (await attempt(() => api(`/property-reports/${id}/refresh`, { method: 'POST', body: {} }))) refresh();
  };
  const remove = async () => {
    if (!(await confirmDialog('Delete this property report?'))) return;
    if (await attempt(() => api(`/property-reports/${id}`, { method: 'DELETE' }), 'Deleted')) location.hash = `#/contacts/${r.contact_id}?tab=tracker`;
  };

  return h('div', header,
    r.error ? h('div.alert.warn-box', 'The last area research didn\'t work: ', r.error) : null,
    r.status === 'sent' ? h('div.alert.info', h('strong', `Sent to ${r.sent_to} ${dateTime(r.sent_at)}. `), 'You can edit it and send it again.') : null,
    !r.booking_ready ? h('div.alert.warn-box', h('strong', 'No booking link yet, so the "Book a time to chat" button is left out of the email. '), 'Connect Calendly in Settings, or add a booking link in Newsletter settings.') : null,
    c.notes_for_broker.length ? h('div.alert.warn-box', h('strong', 'Please check before sending:'), h('ul', c.notes_for_broker.map((x) => h('li', x)))) : null,
    h('div.nl-layout',
      h('section.card.nl-edit',
        h('div.card-head', h('h2', 'Edit'), statusBadge(r.status)),
        h('label.field', h('span', 'Title'), title),
        h('label.field', h('span', 'Introduction'), intro),
        h('h3', 'Your properties'),
        notes.map(({ perf, t }) => h('fieldset.nl-section',
          h('legend', perf?.address || 'Property'),
          perf ? h('p.small.muted', [
            perf.current_value ? `Now ${money(perf.current_value)}` : 'No current valuation',
            perf.growth_pct !== null ? `${perf.growth >= 0 ? '+' : ''}${perf.growth_pct.toFixed(1)}% since ${perf.start.label === 'purchase' ? 'purchase' : 'first valuation'}` : null,
            `${perf.points.length} valuation${perf.points.length === 1 ? '' : 's'} on the chart`,
          ].filter(Boolean).join(' · ')) : null,
          perf && perf.points.length < 2 ? h('p.small.text-warn', 'Only one value on file, so there\'s no chart. Add valuations on the tracker tab to show the history.') : null,
          h('label.field', h('span', 'What to say about it'), t))),
        h('h3', 'The area'),
        areas.map((a) => a.el),
        h('label.field', h('span', 'Closing'), closing),
        h('div.nl-actions',
          saveBtn,
          h('button.secondary', { type: 'button', onclick: pdf }, 'Download PDF'),
          h('button', { type: 'button', onclick: send }, r.status === 'sent' ? 'Email again…' : 'Email to client…'),
          h('span.spacer'),
          h('button.link.small', { type: 'button', onclick: rerun }, 'Refresh area data'),
          h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete'))),
      h('section.card.nl-preview',
        h('div.card-head', h('h2', 'Preview'), tabs),
        frame)));
}
