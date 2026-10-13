// Lead Generator: describe the leads you want; AI searches the web for
// businesses and professionals that match, and you add the good ones to the
// CRM as leads or referral partners.
import { api, h, pageHeader, attempt, toast, confirmDialog, badge, dateTime } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const EXAMPLES = [
  'Real estate agents in Parramatta who sell a lot of first homes',
  'Accountants in Penrith who look after small businesses and tradies',
  'Builders offering house and land packages in Western Sydney',
  'Buyer\'s agents in Brisbane who work with investors',
  'Medical practices in Newcastle (doctors may qualify for LMI waivers)',
  'Financial planners in the Hills District',
];

function compliance() {
  return h('details.card.lg-rules',
    h('summary', h('strong', 'Contacting the leads you find'), h('span.muted.small', ' – Australian spam and privacy rules')),
    h('ul.small',
      h('li', 'The generator only collects contact details businesses publish themselves for enquiries, and skips private individuals.'),
      h('li', 'Leads are added without marketing consent, so they won\'t receive newsletters or marketing texts unless they agree to.'),
      h('li', 'Emailing a business address that\'s published for enquiries is generally OK if your message is relevant to their business role (the Spam Act\'s "inferred consent"). Identify yourself and include a way to opt out.'),
      h('li', 'Before cold-calling, check the number isn\'t on the Do Not Call Register (businesses can register too). A warm approach (a referral, an introduction, a LinkedIn message or a visit) usually works better anyway.'),
      h('li', 'Check each lead\'s details on the source page before reaching out; the AI can get things wrong.')));
}

export async function leadsPage() {
  const data = await api('/leads/searches');
  if (!data.configured) {
    return h('div', pageHeader('Lead Generator'),
      h('section.card', h('h2', 'Set up the lead generator'), h('p', 'The lead generator uses Claude to search the web. An admin needs to add an Anthropic API key in Settings → AI document reading & settlement letters.')));
  }
  const request = h('textarea', { rows: 3, placeholder: 'e.g. Real estate agents in Parramatta who sell a lot of first homes', 'aria-label': 'What leads are you looking for?', maxlength: 1000 });
  const area = h('input', { type: 'text', placeholder: 'e.g. Parramatta NSW (optional)', 'aria-label': 'Area' });
  const type = h('select', { 'aria-label': 'Type of lead' }, Object.entries(data.lead_types).map(([v, l]) => h('option', { value: v }, l)));
  const max = h('select', { 'aria-label': 'How many' }, [10, 15, 20, 30].map((n) => h('option', { value: n, selected: n === 15 }, `Up to ${n}`)));
  const go = h('button', { type: 'submit' }, '🔍 Find leads');
  const form = h('form.lg-form',
    h('label.lg-label', 'What leads are you looking for?'), request,
    h('div.lg-row', h('label', 'Area', area), h('label', 'Looking for', type), h('label', 'Results', max), go),
    h('div.lg-examples', h('span.small.muted', 'Try: '), EXAMPLES.map((e) => h('button.link.small', { type: 'button', onclick: () => { request.value = e; request.focus(); } }, e))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    const r = await attempt(() => api('/leads/searches', { method: 'POST', body: { request: request.value, location: area.value, lead_type: type.value, max_results: Number(max.value) } }));
    go.disabled = false;
    if (r) location.hash = `#/leads/${r.id}`;
  });
  return h('div',
    pageHeader('Lead Generator'),
    h('section.card', h('p.muted.small.lg-intro', 'Describe who you\'re looking for. AI searches the web (agency sites, business directories, professional listings) for businesses and professionals that match, with why they fit and how to approach them. You choose which to add to the CRM.'), form),
    compliance(),
    h('section.card', h('h2', 'Your searches'),
      data.rows.length ? h('div.lg-history', data.rows.map((r) => h('a.lg-history-row', { href: `#/leads/${r.id}` },
        h('span', h('strong', r.request), r.location ? h('span.muted', ` · ${r.location}`) : null),
        h('span.small.muted', r.status === 'searching' ? badge('searching…', 'info') : r.status === 'failed' ? badge('failed', 'danger') : `${r.count} found${r.added ? ` · ${r.added} added` : ''} · ${dateTime(r.created_at)}`))))
        : h('p.empty', 'No searches yet.')));
}

function leadCard(searchId, l) {
  const act = async (path, body, msg) => {
    const r = await attempt(() => api(`/leads/searches/${searchId}/leads/${l.id}/${path}`, { method: 'POST', body }), msg);
    if (r) refresh();
  };
  const place = [l.suburb, l.state].filter(Boolean).join(' ');
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  return h(`article.card.lg-lead.${l.status}`,
    h('div.lg-lead-head',
      h('div', h('h3', l.name), h('div.small.muted', [l.role, l.organisation && l.organisation !== l.name ? l.organisation : null, place].filter(Boolean).join(' · '))),
      badge(l.category_label, 'info')),
    l.relevance ? h('p.lg-why', l.relevance) : null,
    h('div.lg-contact.small',
      l.website ? h('a', { href: l.website, target: '_blank', rel: 'noopener noreferrer' }, `🌐 ${host(l.website)}`) : null,
      l.email ? h('a', { href: `mailto:${l.email}` }, `✉ ${l.email}`) : null,
      l.phone ? h('a', { href: `tel:${l.phone.replace(/\s/g, '')}` }, `☎ ${l.phone}`) : null,
      h('a.muted', { href: l.source_url, target: '_blank', rel: 'noopener noreferrer' }, `Source: ${l.source_title || host(l.source_url)} ↗`)),
    l.outreach_tip ? h('p.small.lg-tip', h('strong', 'Approach: '), l.outreach_tip) : null,
    l.existing ? h('p.small.text-warn', 'Already in the CRM: ', h('a', { href: l.existing.link }, l.existing.name), ` (${l.existing.kind === 'partner' ? 'referral partner' : 'contact'})`) : null,
    h('div.lg-actions',
      l.status === 'added' ? [badge(l.added_as === 'partner' ? 'added as referral partner' : 'added as lead', 'ok'), ' ',
        h('a.small', { href: l.added_as === 'partner' ? '#/partners' : `#/contacts/${l.added_id}` }, 'Open')]
        : l.status === 'dismissed' ? [h('span.small.muted', 'Dismissed '), h('button.link.small', { type: 'button', onclick: () => act('dismiss', { undo: true }) }, 'Undo')]
          : [
            h('button.small', { type: 'button', onclick: () => act('add', { as: 'lead' }, `${l.name} added as a lead`) }, '+ Add as lead'),
            h('button.small.secondary', { type: 'button', onclick: () => act('add', { as: 'partner' }, `${l.name} added as a referral partner`) }, '+ Add as referral partner'),
            h('button.link.small', { type: 'button', onclick: () => act('dismiss', {}) }, 'Dismiss'),
          ]));
}

let poll = null;
export async function leadSearchPage(id) {
  clearTimeout(poll);
  const s = await api(`/leads/searches/${id}`);
  const header = pageHeader('Lead Generator', h('a.button.secondary', { href: '#/leads' }, 'New search'));
  const title = h('section.card.lg-summary', h('div.small.muted', 'You asked for'), h('h2', s.request),
    h('div.small.muted', [s.lead_type_label, s.location, `up to ${s.max_results}`, dateTime(s.created_at)].filter(Boolean).join(' · ')));
  if (s.status === 'searching') {
    poll = setTimeout(() => { if (location.hash === `#/leads/${id}`) refresh(); }, 5000);
    return h('div', header, title, h('section.card.nl-writing', h('div.nl-spinner', { 'aria-hidden': 'true' }), h('h2', 'Searching the web…'),
      h('p.muted', 'This usually takes 2–5 minutes. You can leave this page; you\'ll get a notification when it\'s done.')));
  }
  if (s.status === 'failed') return h('div', header, title, h('div.alert.danger', s.error || 'The search didn\'t work.'));
  const remove = async () => {
    if (!(await confirmDialog('Delete this search? Leads you\'ve already added stay in the CRM.'))) return;
    if (await attempt(() => api(`/leads/searches/${id}`, { method: 'DELETE' }), 'Deleted')) location.hash = '#/leads';
  };
  const open = s.leads.filter((l) => l.status === 'new');
  const done = s.leads.filter((l) => l.status !== 'new');
  return h('div', header, title,
    s.notes.length ? h('div.alert.info.small', h('strong', 'Search notes: '), s.notes.join(' ')) : null,
    s.leads.length ? null : h('section.card', h('p.empty', 'No matching leads were found. Try a broader request or a bigger area.')),
    open.length ? h('div.lg-grid', open.map((l) => leadCard(id, l))) : null,
    done.length ? h('details.lg-done', { open: !open.length }, h('summary', `Added or dismissed (${done.length})`), h('div.lg-grid', done.map((l) => leadCard(id, l)))) : null,
    compliance(),
    h('p.small', h('button.link.small.text-danger', { type: 'button', onclick: remove }, 'Delete this search')));
}
