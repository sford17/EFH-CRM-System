// Borrowers on a deal: the main borrower plus any number of co-borrowers,
// each a person, company or trust. Companies and trusts can be created here,
// linked to the main borrower as director, trustee and so on.
import { api, h, label, fullName, formModal, attempt, toast } from '../core.js';

export const ENTITY_LABELS = { person: 'Person', company: 'Company', trust: 'Trust' };
export const ENTITY_ROLES = ['director', 'shareholder', 'trustee', 'beneficiary', 'appointor', 'guarantor'];
export const TRUST_TYPES = [['discretionary', 'Discretionary (family) trust'], ['unit', 'Unit trust'], ['hybrid', 'Hybrid trust'], ['smsf', 'Self-managed super fund'], ['testamentary', 'Testamentary trust'], ['other', 'Other']];
export const entityBadge = (c) => (c?.entity_type && c.entity_type !== 'person' ? h(`span.badge.entity.${c.entity_type}`, ENTITY_LABELS[c.entity_type]) : null);

// A company or trust created on the spot, linked to `linkTo` (a person) in the role chosen.
export function newEntityDialog({ linkTo = null, type = 'trust', onCreated }) {
  const fields = [
    { name: 'entity_type', label: 'Type', type: 'select', required: true, options: [['trust', 'Trust'], ['company', 'Company']], default: type },
    { name: 'first_name', label: 'Name (e.g. Jones Family Trust or Jones Holdings Pty Ltd)', required: true, full: true },
    { name: 'abn', label: 'ABN' },
    { name: 'acn', label: 'ACN (company, or a trust\'s corporate trustee)' },
    { name: 'trust_type', label: 'Kind of trust', type: 'select', options: TRUST_TYPES },
    ...(linkTo ? [{ name: 'relationship', label: `${linkTo.first_name} is its…`, type: 'select', options: ENTITY_ROLES.map((r) => [r, label(r)]), default: type === 'company' ? 'director' : 'trustee' }] : []),
  ];
  const d = formModal('New company or trust', fields, { entity_type: type }, async (v) => {
    const { relationship, ...entity } = v;
    if (entity.entity_type === 'company') entity.trust_type = null;
    let id;
    if (linkTo && relationship) {
      id = (await attempt(() => api(`/contacts/${linkTo.id}/relationships`, { method: 'POST', body: { relationship, new_contact: entity } }), `${entity.first_name} added`)).related_id;
    } else {
      id = (await attempt(() => api('/contacts', { method: 'POST', body: entity }), `${entity.first_name} added`)).id;
    }
    onCreated?.({ id, first_name: entity.first_name, last_name: null, entity_type: entity.entity_type });
  }, { wide: false, submitLabel: 'Add' });
  // The role list follows the type: directors for a company, trustees for a trust.
  const form = d.querySelector('form');
  const sync = () => {
    const trust = form.elements.entity_type.value === 'trust';
    form.elements.trust_type.closest('.field').hidden = !trust;
    if (form.elements.relationship) form.elements.relationship.value = trust ? 'trustee' : 'director';
  };
  form.elements.entity_type.addEventListener('change', sync);
  sync();
  return d;
}

// The "Borrowers" part of the deal form. `chooseMain` adds a main-borrower picker (new deal from the Deals page).
export async function borrowersFieldset({ mainId = null, coIds = [], chooseMain = false } = {}) {
  const { rows: everyone } = await api('/contacts?limit=500');
  const byId = new Map(everyone.map((c) => [c.id, c]));
  let related = [];
  const loadRelated = async (id) => {
    related = id ? (await api(`/contacts/${id}/household`)).related.map((r) => ({ ...r.contact, relationship: r.relationship })) : [];
  };
  await loadRelated(mainId);

  const nameOf = (c) => `${fullName(c)}${c.entity_type && c.entity_type !== 'person' ? ` (${ENTITY_LABELS[c.entity_type].toLowerCase()})` : ''}`;
  const options = (selected) => {
    const rel = related.filter((r) => r.id !== Number(mainSel?.value || mainId));
    const relIds = new Set(rel.map((r) => r.id));
    const rest = everyone.filter((c) => c.id !== Number(mainSel?.value || mainId) && !relIds.has(c.id));
    return [
      h('option', { value: '' }, 'Choose who…'),
      rel.length ? h('optgroup', { label: 'Related to the borrower' }, rel.map((c) => h('option', { value: c.id, selected: c.id === selected }, `${nameOf(c)} · ${label(c.relationship)}`))) : null,
      h('optgroup', { label: 'All contacts' }, rest.map((c) => h('option', { value: c.id, selected: c.id === selected }, nameOf(c)))),
    ];
  };

  const list = h('div.borrower-rows');
  const addRow = (selected = null) => {
    const sel = h('select', { 'aria-label': 'Co-borrower', class: 'co-borrower' }, options(selected));
    const row = h('div.borrower-row', h('span.borrower-tag', 'Co-borrower'), sel,
      h('button.icon', { type: 'button', 'aria-label': 'Remove co-borrower', title: 'Remove', onclick: () => { row.remove(); renumber(); } }, '×'));
    list.append(row);
    renumber();
    return sel;
  };
  const renumber = () => {
    const rows = [...list.children];
    rows.forEach((r, i) => { r.querySelector('.borrower-tag').textContent = rows.length > 1 ? `Co-borrower ${i + 1}` : 'Co-borrower'; });
  };
  const refreshOptions = () => {
    for (const sel of list.querySelectorAll('select')) {
      const v = Number(sel.value) || null;
      sel.replaceChildren(...options(v).filter(Boolean));
    }
  };

  let mainSel = null;
  if (chooseMain) {
    mainSel = h('select', { name: 'contact_id', required: true, 'aria-label': 'Main borrower' },
      h('option', { value: '' }, 'Choose the client…'), everyone.map((c) => h('option', { value: c.id, selected: c.id === mainId }, nameOf(c))));
    mainSel.addEventListener('change', async () => { await loadRelated(Number(mainSel.value)); refreshOptions(); });
  }
  for (const id of coIds) addRow(id);

  const newEntity = () => {
    const main = byId.get(Number(mainSel?.value || mainId));
    newEntityDialog({
      linkTo: main && main.entity_type === 'person' ? main : null,
      onCreated: async (c) => {
        everyone.push(c);
        byId.set(c.id, c);
        await loadRelated(Number(mainSel?.value || mainId));
        refreshOptions();
        const sel = addRow(c.id);
        sel.value = String(c.id);
      },
    });
  };

  const el = h('fieldset.borrowers-fieldset.full',
    h('legend', 'Borrowers'),
    chooseMain ? h('div.borrower-row.borrower-main', h('span.borrower-tag', 'Main borrower'), mainSel) : null,
    !chooseMain && mainId ? h('div.borrower-row.borrower-main', h('span.borrower-tag', 'Main borrower'), h('strong', nameOf(byId.get(Number(mainId)) || { first_name: 'This client' }))) : null,
    list,
    h('div.borrower-actions',
      h('button.secondary.small', { type: 'button', onclick: () => { const sel = addRow(); sel.focus(); } }, '+ Add co-borrower'),
      h('button.secondary.small', { type: 'button', onclick: newEntity }, '+ New company or trust')),
    h('p.small.muted', 'Add as many co-borrowers as the loan has. A company or trust can be a borrower; link its directors or trustees on its contact page so emails reach them.'));
  return {
    el,
    read() {
      const ids = [...list.querySelectorAll('select')].map((s) => Number(s.value)).filter(Boolean);
      const main = Number(mainSel?.value || mainId) || null;
      if (chooseMain && !main) { toast('Choose the main borrower', 'error'); throw Object.assign(new Error('Choose the main borrower'), { toasted: true }); }
      return { ...(chooseMain ? { contact_id: main } : {}), co_borrower_ids: [...new Set(ids)].filter((id) => id !== main) };
    },
  };
}
