// Related contacts (partners, family, guarantors…) and the "address to" picker
// used wherever a document or email can go to one or both of a couple.
import {
  api, h, label, attempt, confirmDialog, formModal, modal, field, readForm, fullName, toast,
} from '../core.js';
import { newEntityDialog, entityBadge } from './borrowers.js';

export const RELATIONSHIPS = ['spouse', 'de_facto', 'partner', 'parent', 'child', 'sibling', 'relative', 'business_partner', 'guarantor', 'accountant', 'solicitor', 'other'];
// How a person is linked to a company or trust.
const ENTITY_LINKS = ['director', 'shareholder', 'trustee', 'beneficiary', 'appointor', 'guarantor', 'accountant', 'solicitor', 'other'];
const isEntity = (c) => c && c.entity_type && c.entity_type !== 'person';
// "Director of" from the person's side, "Director" from the company's.
const relText = (r) => `${label(r.relationship)}${isEntity(r.contact) && ENTITY_LINKS.slice(0, 6).includes(r.relationship) ? ' of' : ''}`;
const PARTNER_TYPES = ['spouse', 'de_facto', 'partner'];
const relOptions = (entity = false) => (entity ? ENTITY_LINKS : RELATIONSHIPS).map((r) => [r, label(r)]);
const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

// "Related contacts" card on a contact's overview.
export function relatedCard(c) {
  const partners = c.household.filter((m) => m.id !== c.id);
  const entity = isEntity(c);
  return h('section.card',
    h('div.card-head', h('h2', entity ? (c.entity_type === 'trust' ? 'Trustees & people' : 'Directors & people') : 'Related contacts'),
      h('div.card-head-buttons',
        entity ? null : h('button.small.secondary', { type: 'button', onclick: () => newEntityDialog({ linkTo: c, onCreated: refresh }) }, '+ Company or trust'),
        h('button.small', { type: 'button', onclick: () => linkContactDialog(c) }, entity ? '+ Link person' : '+ Link'))),
    entity && !c.relationships.length ? h('p.small.text-warn', `Link the ${c.entity_type === 'trust' ? 'trustees' : 'directors'} so emails about ${c.first_name}'s loans reach them.`) : null,
    partners.length ? h('p.muted.small', `Finances shared with ${partners.map((m) => m.first_name).join(', ')}: loans, properties and assets show on both profiles.`) : null,
    c.relationships.length
      ? h('ul.plain.related-list', c.relationships.map((r) => h('li',
        h('div',
          h('a', { href: `#/contacts/${r.contact.id}` }, r.contact.full_name), entityBadge(r.contact),
          h('span.muted', ` · ${relText(r)}`),
          r.shared_finances ? h('span.badge.ok', { title: 'Mortgage tracker, deals and documents are shared' }, 'Shared finances') : null),
        h('div.muted.small', [r.contact.email, r.contact.mobile].filter(Boolean).join(' · ') || 'No contact details'),
        r.notes ? h('div.small', r.notes) : null,
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => editRelationship(c, r) }, 'Edit'),
          h('button.link.small.text-danger', { type: 'button', onclick: () => removeRelationship(c, r) }, 'Unlink')))))
      : entity ? null : h('p.empty', 'No related contacts. Link a partner to combine their finances and send joint documents, or add a company or trust they borrow through.'));
}

async function linkContactDialog(c) {
  const { rows } = await api('/contacts?limit=1000');
  const linked = new Set(c.relationships.map((r) => r.contact.id));
  const entity = isEntity(c);
  // A company or trust links to people; a person can link to anyone.
  const others = rows.filter((o) => o.id !== c.id && !linked.has(o.id) && !(entity && isEntity(o)));
  const byId = new Map(others.map((o) => [o.id, o]));

  const mode = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Who to link' });
  const existingFields = [{ name: 'related_id', label: 'Contact', type: 'select', full: true, options: others.map((o) => [o.id, `${fullName(o)}${isEntity(o) ? ` (${o.entity_type})` : ''}${o.email ? ` (${o.email})` : ''}`]) }];
  const newFields = [
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'mobile', label: 'Mobile' },
    { name: 'dob', label: 'Date of birth', type: 'date' },
  ];
  const relFields = [
    { name: 'relationship', label: entity ? `Their role in ${c.first_name}` : 'Relationship', type: 'select', required: true, options: relOptions(entity), default: entity ? (c.entity_type === 'trust' ? 'trustee' : 'director') : 'spouse' },
    { name: 'shared_finances', label: 'Shares finances with this contact (joint loans & properties)', type: 'checkbox', default: true, full: true },
    { name: 'copy_address', label: 'Copy the address to whoever doesn\'t have one', type: 'checkbox', default: true, full: true },
    { name: 'notes', label: 'Notes', full: true },
  ];

  const existingBox = h('div.grid-form', existingFields.map((f) => field(f)));
  const newBox = h('div.grid-form', newFields.map((f) => field(f, f.name === 'last_name' && !entity ? c.last_name : undefined)),
    h('p.muted.small.full', entity ? `Status, owner and lead source are copied from ${c.first_name}.` : `Status, owner, lead source and address are copied from ${c.first_name}.`));
  const form = h('form', existingBox, newBox, h('div.grid-form', relFields.map((f) => field(f))),
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Link contact')));

  let creating = !others.length;
  const show = () => {
    existingBox.hidden = creating;
    newBox.hidden = !creating;
    existingBox.querySelector('select').required = !creating;
    newBox.querySelector('[name=first_name]').required = creating;
    for (const b of mode.children) b.setAttribute('aria-checked', String((b.dataset.mode === 'new') === creating));
  };
  for (const [key, text] of [['existing', 'Existing contact'], ['new', 'New contact']]) {
    mode.append(h('button.secondary', { type: 'button', role: 'radio', dataset: { mode: key }, onclick: () => { creating = key === 'new'; show(); } }, text));
  }
  show();

  // Partners usually share finances; other relationships usually don't.
  const relSelect = form.elements.relationship;
  relSelect.addEventListener('change', () => { form.elements.shared_finances.checked = PARTNER_TYPES.includes(relSelect.value); });
  // Linking to a company or trust: roles like director or trustee, and no shared finances.
  const syncKind = () => {
    const target = entity || (!creating && isEntity(byId.get(Number(form.elements.related_id.value))));
    const wanted = relOptions(target);
    if ([...relSelect.options].map((o) => o.value).join() !== wanted.map(([v]) => v).join()) {
      relSelect.replaceChildren(...wanted.map(([v, l]) => h('option', { value: v }, l)));
      relSelect.value = target ? (entity && c.entity_type === 'company' ? 'director' : target && !entity && byId.get(Number(form.elements.related_id.value))?.entity_type === 'company' ? 'director' : 'trustee') : 'spouse';
    }
    for (const n of ['shared_finances', 'copy_address']) {
      form.elements[n].closest('.field').hidden = target;
      if (target) form.elements[n].checked = false;
    }
  };
  form.elements.related_id.addEventListener('change', syncKind);
  for (const b of mode.children) b.addEventListener('click', syncKind);
  syncKind();

  const dialog = modal(entity ? `Link a person to ${fullName(c)}` : `Link a contact to ${fullName(c)}`, [mode, form], { wide: true });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rel = readForm(form, relFields);
    const body = creating ? { ...rel, new_contact: readForm(form, newFields) } : { ...rel, related_id: Number(form.elements.related_id.value) };
    try {
      await attempt(() => api(`/contacts/${c.id}/relationships`, { method: 'POST', body }), 'Contacts linked');
      dialog.close();
      refresh();
    } catch { /* toast shown */ }
  });
}

function editRelationship(c, r) {
  formModal(`${fullName(c)} & ${r.contact.full_name}`, [
    { name: 'relationship', label: isEntity(c) || isEntity(r.contact) ? 'Role' : `${r.contact.first_name} is ${c.first_name}'s…`, type: 'select', required: true, options: relOptions(isEntity(c) || isEntity(r.contact)) },
    { name: 'shared_finances', label: 'Shares finances (joint loans & properties)', type: 'checkbox', full: true },
    { name: 'notes', label: 'Notes', full: true },
  ], { ...r, shared_finances: r.shared_finances ? 1 : 0, relationship: storedRelationship(r) }, async (v) => {
    await attempt(() => api(`/contacts/relationships/${r.id}`, { method: 'PATCH', body: { ...v, relationship: storedRelationship({ ...r, relationship: v.relationship }) } }), 'Saved');
    refresh();
  }, { wide: false });
}

// Parent/child are stored from the other side when this contact is the
// "related" one; the server reports them flipped, so flip back to save.
function storedRelationship(r) {
  if (!r.reversed) return r.relationship;
  return { parent: 'child', child: 'parent' }[r.relationship] || r.relationship;
}

async function removeRelationship(c, r) {
  if (!(await confirmDialog(`Unlink ${r.contact.full_name} from ${fullName(c)}? Both contacts are kept, but their finances will no longer be combined.`))) return;
  await attempt(() => api(`/contacts/relationships/${r.id}`, { method: 'DELETE' }), 'Unlinked');
  refresh();
}

// Checkboxes to address something to one or more of a household. Returns
// null for a single person. `onChange(ids)` fires with the ticked ids.
export function addresseePicker(members, selected, onChange) {
  if (!members || members.length < 2) return null;
  const chosen = new Set(selected.map(Number));
  const boxes = members.map((m) => {
    const input = h('input', { type: 'checkbox', checked: chosen.has(m.id), value: m.id });
    input.addEventListener('change', () => {
      if (input.checked) chosen.add(m.id);
      else if (chosen.size > 1) chosen.delete(m.id);
      else { input.checked = true; toast('Address it to at least one person', 'error'); return; }
      onChange(members.filter((x) => chosen.has(x.id)).map((x) => x.id));
    });
    return h('label.check-pill', input, fullName(m), m.email ? null : h('span.muted.small', ' (no email)'));
  });
  return h('fieldset.addressees', h('legend', 'Address to'), boxes);
}

export const householdOf = async (contactId, dealId = null) => (contactId ? (await api(`/contacts/${contactId}/household${dealId ? `?deal_id=${dealId}` : ''}`)).rows : []);
