import {
  api, h, table, badge, date, money, money2, pct, pageHeader, formModal, attempt, confirmDialog, state, stageLabel,
  label, userOptions, todayStr, relDays, opts, dateTime, lenderTag, lenderLogo,
} from '../core.js';
import { dealFields, coBorrowerField, newDeal, newTask, taskTable, timeline, sendTemplateDialog, refresh } from './forms.js';
import { emailsCard, composeDialog } from './email.js';
import { partiesCard } from './parties.js';
import { emailLenderDialog } from './lenders.js';
import { requestReviewDialog } from './googleReview.js';
import { signingCard } from './signing.js';
import { smsCard } from './sms.js';
import { dealPurchaseCard } from './purchaseCalc.js';
import { settlementLetterCard } from './settlementLetter.js';

// Moves a deal, asking for extra details where a stage needs them.
export async function moveDeal(deal, stage) {
  if (stage === deal.stage) return false;
  if (stage === 'lost') {
    return new Promise((resolve) => {
      const d = formModal('Mark deal as lost', [{ name: 'lost_reason', label: 'Why was it lost?', required: true, full: true }], {}, async (v) => {
        await attempt(() => api(`/deals/${deal.id}/stage`, { method: 'POST', body: { stage, ...v } }), 'Deal marked lost');
        resolve(true);
      }, { wide: false });
      d.addEventListener('close', () => resolve(false));
    });
  }
  if (stage === 'settled') {
    return new Promise((resolve) => {
      const d = formModal('Mark deal as settled', [{ name: 'settlement_date', label: 'Settlement date', type: 'date', required: true }],
        { settlement_date: deal.settlement_date || todayStr() }, async (v) => {
          await attempt(() => api(`/deals/${deal.id}/stage`, { method: 'POST', body: { stage, ...v } }), 'Settled! Automations are running.');
          resolve(true);
        }, { wide: false, submitLabel: 'Mark settled' });
      d.addEventListener('close', () => resolve(false));
    });
  }
  await attempt(() => api(`/deals/${deal.id}/stage`, { method: 'POST', body: { stage } }), `Moved to ${stageLabel(stage)}`);
  return true;
}

let pipelineOwner = '';

export async function pipelinePage() {
  const board = h('div.kanban');
  const load = async () => {
    const { stages } = await api(`/deals/pipeline${pipelineOwner ? `?owner_id=${pipelineOwner}` : ''}`);
    board.replaceChildren(...stages.map((s) => {
      const col = h(`section.kanban-col.stage-${s.key}`, { dataset: { stage: s.key } },
        h('header', h('h2', s.label), h('div.muted', `${s.deals.length} · ${money(s.total)}`)),
        h('div.kanban-cards', s.deals.map((d) => card(d))));
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const deal = JSON.parse(e.dataTransfer.getData('application/json'));
        if (await moveDeal(deal, s.key)) load();
      });
      return col;
    }));
  };
  const card = (d) => {
    const el = h(`article.deal-card${d.priority === 'high' ? '.high' : ''}`, { draggable: 'true' },
      h('a', { href: `#/deals/${d.id}` }, d.title),
      h('div.deal-amount', money(d.loan_amount), d.lvr ? h('span.muted', ` · LVR ${d.lvr}%`) : null),
      d.lender_name ? h('div.card-lender', lenderLogo(d.lender_logo_id, d.lender_name), h('span.muted', d.lender_name)) : null,
      d.owner_name ? h('div.muted', d.owner_name) : null,
      d.finance_due_date && !['settled', 'lost', 'unconditional_approval', 'settlement_booked'].includes(d.stage)
        ? h('div.small.text-warn', `Finance due ${relDays(d.finance_due_date)}`) : null,
      d.settlement_date && ['unconditional_approval', 'settlement_booked'].includes(d.stage)
        ? h('div.small', `Settles ${date(d.settlement_date)}`) : null,
      h('select.stage-select', {
        'aria-label': `Move ${d.title} to stage`,
        onchange: async (e) => { if (await moveDeal(d, e.target.value)) load(); else e.target.value = d.stage; },
      }, state.meta.stages.map((s) => h('option', { value: s.key, selected: s.key === d.stage }, s.label))));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ id: d.id, stage: d.stage, settlement_date: d.settlement_date }));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  };
  const owner = h('select', { 'aria-label': 'Filter by broker' }, h('option', { value: '' }, 'All brokers'), userOptions().map(([v, l]) => h('option', { value: v, selected: String(v) === pipelineOwner }, l)));
  owner.addEventListener('change', () => { pipelineOwner = owner.value; load(); });
  await load();
  return h('div',
    pageHeader('Pipeline', owner, h('button', { type: 'button', onclick: () => newDeal() }, '+ New deal')),
    h('p.muted', 'Drag cards between stages (or use the stage menu on each card). Settled and lost deals show for 90 days.'),
    board);
}

const dealFilters = { q: '', stage: '', open: '1' };

export async function dealsPage() {
  const results = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(dealFilters).filter(([, v]) => v)).toString();
    const { rows } = await api(`/deals?${qs}`);
    results.replaceChildren(table([
      { label: 'Deal', value: (d) => h('a', { href: `#/deals/${d.id}` }, d.title) },
      { label: 'Borrower', value: (d) => h('a', { href: `#/contacts/${d.contact_id}` }, d.contact_name) },
      { label: 'Stage', value: (d) => badge(stageLabel(d.stage), d.stage === 'settled' ? 'ok' : d.stage === 'lost' ? 'danger' : 'info') },
      { label: 'Loan', value: (d) => money(d.loan_amount), class: 'num' },
      { label: 'LVR', value: (d) => (d.lvr ? `${d.lvr}%` : '—'), class: 'num' },
      { label: 'Lender', value: (d) => lenderTag(d.lender_logo_id, d.lender_name) },
      { label: 'Broker', value: (d) => d.owner_name || '—' },
      { label: 'Updated', value: (d) => date(d.updated_at) },
    ], rows, { onRow: (d) => { location.hash = `#/deals/${d.id}`; }, empty: 'No deals match.' }));
  };
  const q = h('input', { type: 'search', placeholder: 'Search deal, borrower, address, app ref…', value: dealFilters.q, 'aria-label': 'Search deals' });
  q.addEventListener('input', () => { dealFilters.q = q.value; load(); });
  const stage = h('select', { 'aria-label': 'Stage' }, h('option', { value: '' }, 'All stages'), state.meta.stages.map((s) => h('option', { value: s.key, selected: s.key === dealFilters.stage }, s.label)));
  stage.addEventListener('change', () => { dealFilters.stage = stage.value; load(); });
  const open = h('select', { 'aria-label': 'Open or all' }, h('option', { value: '1', selected: dealFilters.open === '1' }, 'Open deals'), h('option', { value: '', selected: dealFilters.open === '' }, 'All deals'));
  open.addEventListener('change', () => { dealFilters.open = open.value; load(); });
  await load();
  return h('div', pageHeader('Deals', h('button', { type: 'button', onclick: () => newDeal() }, '+ New deal')), h('div.filters', q, stage, open), results);
}

const DOC_STATUSES = ['required', 'requested', 'received', 'verified', 'not_applicable'];

function documentsCard(deal) {
  const counts = DOC_STATUSES.reduce((acc, s) => ({ ...acc, [s]: deal.documents.filter((d) => d.status === s).length }), {});
  const done = counts.received + counts.verified + counts.not_applicable;
  const addDoc = () => formModal('Add document', [
    { name: 'name', label: 'Document', required: true, full: true },
    { name: 'category', label: 'Category', type: 'select', options: opts(['identity', 'income', 'banking', 'liabilities', 'property', 'compliance', 'other']) },
    { name: 'link', label: 'Link (e.g. to file in your document storage)', full: true },
  ], {}, async (v) => { await attempt(() => api(`/deals/${deal.id}/documents`, { method: 'POST', body: v }), 'Added'); refresh(); }, { wide: false });

  return h('section.card',
    h('div.card-head', h('h2', `Documents (${done}/${deal.documents.length})`),
      h('div.actions',
        h('button.small.secondary', { type: 'button', onclick: async () => { await attempt(() => api(`/deals/${deal.id}/documents/checklist`, { method: 'POST', body: {} }), 'Checklist updated'); refresh(); } }, 'Add standard checklist'),
        h('button.small.secondary', { type: 'button', onclick: async () => { await attempt(() => api(`/deals/${deal.id}/documents/request`, { method: 'POST', body: {} }), 'Document request emailed'); refresh(); } }, 'Email request'),
        h('button.small', { type: 'button', onclick: addDoc }, '+ Add'))),
    deal.documents.length ? h('div.meter', h('div.meter-fill', { style: { width: `${(done / deal.documents.length) * 100}%` } })) : null,
    deal.documents.length
      ? h('ul.doc-list', deal.documents.map((d) => h(`li.doc-${d.status}`,
        h('div', d.link ? h('a', { href: d.link, target: '_blank', rel: 'noopener noreferrer' }, d.name) : d.name, h('span.muted.small', ` ${label(d.category || '')}`)),
        h('select', {
          'aria-label': `Status of ${d.name}`,
          onchange: async (e) => { await attempt(() => api(`/documents/${d.id}`, { method: 'PATCH', body: { status: e.target.value } })); refresh(); },
        }, DOC_STATUSES.map((s) => h('option', { value: s, selected: s === d.status }, label(s)))),
        h('button.icon.small', { type: 'button', 'aria-label': `Remove ${d.name}`, onclick: async () => { await attempt(() => api(`/documents/${d.id}`, { method: 'DELETE' })); refresh(); } }, '×'))))
      : h('p.empty', 'No documents yet. Add the standard checklist to get started.'));
}

function commissionsCard(deal) {
  if (!deal.commissions.length) {
    return h('section.card', h('h2', 'Commissions'),
      h('p.empty', deal.stage === 'settled' ? 'No commission entries. Set a lender and loan amount, then generate.' : 'Commission entries are created automatically when the deal settles.'),
      deal.stage === 'settled' ? h('button.small', { type: 'button', onclick: async () => { await attempt(() => api(`/deals/${deal.id}/commissions/generate`, { method: 'POST', body: {} }), 'Generated'); refresh(); } }, 'Generate commissions') : null);
  }
  const total = deal.commissions.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + c.amount, 0);
  const received = deal.commissions.filter((c) => ['received', 'paid'].includes(c.status)).reduce((s, c) => s + c.amount, 0);
  return h('section.card', h('h2', 'Commissions'),
    h('p', h('strong', money2(total)), ' expected · ', h('strong', money2(received)), ' received'),
    h('details', h('summary', `${deal.commissions.length} entries`),
      table([
        { label: 'Type', value: (c) => label(c.type) },
        { label: 'Period', value: (c) => c.period || '—' },
        { label: 'Amount', value: (c) => money2(c.amount), class: 'num' },
        { label: 'Status', value: (c) => badge(c.status, c.status === 'received' ? 'ok' : '') },
      ], deal.commissions)));
}

export async function dealPage(id) {
  const deal = await api(`/deals/${id}`);
  const edit = async () => formModal(`Edit ${deal.title}`, [(await coBorrowerField(deal.contact_id, deal.co_borrower_id)).field, ...dealFields()], deal, async (v) => {
    await attempt(() => api(`/deals/${id}`, { method: 'PATCH', body: v }), 'Saved');
    refresh();
  });
  const remove = async () => {
    if (!(await confirmDialog(`Delete "${deal.title}"? Its tasks, documents and commissions will also be removed.`))) return;
    await attempt(() => api(`/deals/${id}`, { method: 'DELETE' }), 'Deal deleted');
    location.hash = '#/pipeline';
  };
  const stages = state.meta.stages.filter((s) => s.key !== 'lost');
  const currentIdx = stages.findIndex((s) => s.key === deal.stage);
  const info = (k, v) => (v || v === 0 ? h('div.info-row', h('dt', k), h('dd', v)) : null);

  return h('div',
    h('div.page-header',
      h('div', h('h1', deal.title, ' ', deal.priority === 'high' ? badge('high priority', 'danger') : null),
        h('div.muted', 'Borrower: ', h('a', { href: `#/contacts/${deal.contact_id}` }, deal.contact_name),
          deal.co_borrower_name ? [' & ', h('a', { href: `#/contacts/${deal.co_borrower_id}` }, deal.co_borrower_name)] : null)),
      h('div.actions',
        h('button.secondary', { type: 'button', onclick: () => sendTemplateDialog({ dealId: deal.id, contactId: deal.contact_id, parties: deal.parties }) }, 'Send template'),
        deal.stage === 'settled' ? h('button.secondary', { type: 'button', onclick: async () => requestReviewDialog({ contact: await api(`/contacts/${deal.contact_id}`), dealId: deal.id }) }, '⭐ Review request') : null,
        deal.lender_id ? h('button.secondary', { type: 'button', onclick: () => emailLenderDialog({ lenderId: deal.lender_id, contactId: deal.contact_id, dealId: deal.id }) }, `Email ${deal.lender_name} BDM`) : null,
        h('button.secondary', { type: 'button', onclick: edit }, 'Edit'),
        deal.stage !== 'lost' ? h('button.secondary', { type: 'button', onclick: async () => { if (await moveDeal(deal, 'lost')) refresh(); } }, 'Mark lost') : null,
        h('button.danger.ghost', { type: 'button', onclick: remove }, 'Delete'))),
    h('ol.stepper', { 'aria-label': 'Deal stage' }, stages.map((s, i) => h(`li${i < currentIdx ? '.done' : ''}${i === currentIdx ? '.current' : ''}`,
      h('button', {
        type: 'button', 'aria-current': i === currentIdx ? 'step' : undefined,
        onclick: async () => { if (await moveDeal(deal, s.key)) refresh(); },
      }, s.label)))),
    deal.stage === 'lost' ? h('div.alert.danger', `Lost: ${deal.lost_reason || 'no reason given'}`) : null,
    h('div.detail-grid',
      h('div.col-side',
        h('section.card', h('h2', 'Loan'), h('dl.info',
          info('Purpose', label(deal.loan_purpose)),
          info('Property', deal.property_address),
          info('Property value', deal.property_value ? money(deal.property_value) : null),
          info('Loan amount', deal.loan_amount ? money(deal.loan_amount) : null),
          info('LVR', deal.lvr ? `${deal.lvr}%` : null),
          info('Deposit / equity', deal.deposit ? money(deal.deposit) : null),
          info('Lender', deal.lender_name ? h('a', { href: `#/lenders/${deal.lender_id}` }, lenderTag(deal.lender_logo_id, deal.lender_name, 'md')) : null),
          deal.lender_id ? info('Accreditation', deal.accreditation?.accreditation_number
            ? h('span', h('span.mono', deal.accreditation.accreditation_number), deal.accreditation.status !== 'active' ? [' ', badge(deal.accreditation.status, 'warn')] : null,
              deal.accreditation.renewal_overdue ? h('span.text-danger.small', ' renewal overdue') : null)
            : h('a.small', { href: `#/lenders/${deal.lender_id}` }, `Add ${deal.owner_name ? `${deal.owner_name.split(' ')[0]}'s` : 'the broker\'s'} number`)) : null,
          deal.lender_contacts?.[0] ? info('BDM', h('span', deal.lender_contacts[0].name,
            deal.lender_contacts[0].mobile || deal.lender_contacts[0].phone ? [' · ', h('a', { href: `tel:${(deal.lender_contacts[0].mobile || deal.lender_contacts[0].phone).replace(/\s/g, '')}` }, deal.lender_contacts[0].mobile || deal.lender_contacts[0].phone)] : null)) : null,
          info('Product', deal.product_name),
          info('Rate', deal.interest_rate ? `${pct(deal.interest_rate)} ${label(deal.rate_type || '')}` : null),
          info('Fixed expiry', deal.fixed_expiry_date ? `${date(deal.fixed_expiry_date)} (${relDays(deal.fixed_expiry_date)})` : null),
          info('Term', deal.loan_term_years ? `${deal.loan_term_years} years, ${deal.repayment_type === 'io' ? 'interest only' : 'P&I'}` : null),
          info('App ref', deal.application_ref),
          info('Broker', deal.owner_name),
          info('Referral partner', deal.partner_name))),
        partiesCard(deal, { compose: (p) => composeDialog({ contactId: deal.contact_id, dealId: deal.id, to: p.email, toParty: p }) }),
        h('section.card', h('h2', 'Key dates'), h('dl.info',
          info('Pre-approval expires', deal.pre_approval_expiry ? `${date(deal.pre_approval_expiry)} (${relDays(deal.pre_approval_expiry)})` : '—'),
          info('Finance due', deal.finance_due_date ? `${date(deal.finance_due_date)} (${relDays(deal.finance_due_date)})` : '—'),
          info('Settlement', deal.settlement_date ? `${date(deal.settlement_date)} (${relDays(deal.settlement_date)})` : '—'),
          info('In stage since', date(deal.stage_changed_at)),
          info('Created', date(deal.created_at)))),
        commissionsCard(deal),
        h('section.card', h('h2', 'Stage history'), h('ul.plain', deal.stage_history.map((s) => h('li',
          `${s.from_stage ? `${stageLabel(s.from_stage)} → ` : ''}${stageLabel(s.to_stage)}`,
          h('div.muted', `${dateTime(s.changed_at)}${s.user_name ? ` · ${s.user_name}` : ''}`)))))),
      h('div.col-main',
        await settlementLetterCard(deal),
        await dealPurchaseCard(deal),
        documentsCard(deal),
        h('section.card',
          h('div.card-head', h('h2', 'Tasks'), h('button.small', { type: 'button', onclick: () => newTask({ deal_id: deal.id, contact_id: deal.contact_id }) }, '+ Task')),
          taskTable(deal.tasks)),
        signingCard({ requests: deal.sign_requests, contact: { id: deal.contact_id }, deal }),
        emailsCard({ mail: deal.mail, outbox: deal.emails, contactId: deal.contact_id, dealId: deal.id, to: deal.contact_email }),
        smsCard({ sms: deal.sms, contactId: deal.contact_id, dealId: deal.id, mobile: deal.contact_mobile, name: deal.contact_name.split(' ')[0] }),
        h('section.card', h('h2', 'Activity'), timeline(deal.activities, { contactId: deal.contact_id, dealId: deal.id })))));
}
