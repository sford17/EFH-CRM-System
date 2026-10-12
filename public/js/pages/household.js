// Related contacts (partners, family, guarantors…) and the "address to" picker
// used wherever a document or email can go to one or both of a couple.
import {
  api, h, label, attempt, confirmDialog, formModal, modal, field, readForm, fullName, toast,
} from '../core.js';

export const RELATIONSHIPS = ['spouse', 'de_facto', 'partner', 'parent', 'child', 'sibling', 'relative', 'business_partner', 'guarantor', 'accountant', 'solicitor', 'other'];
const PARTNER_TYPES = ['spouse', 'de_facto', 'partner'];
const relOptions = () => RELATIONSHIPS.map((r) => [r, label(r)]);
const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

// "Related contacts" card on a contact's overview.
export function relatedCard(c) {
  const partners = c.household.filter((m) => m.id !== c.id);
  return h('section.card',
    h('div.card-head', h('h2', 'Related contacts'), h('button.small', { type: 'button', onclick: () => linkContactDialog(c) }, '+ Link contact')),
    partners.length ? h('p.muted.small', `Finances shared with ${partners.map((m) => m.first_name).join(', ')}: loans, properties and assets show on both profiles.`) : null,
    c.relationships.length
      ? h('ul.plain.related-list', c.relationships.map((r) => h('li',
        h('div',
          h('a', { href: `#/contacts/${r.contact.id}` }, r.contact.full_name),
          h('span.muted', ` · ${label(r.relationship)}`),
          r.shared_finances ? h('span.badge.ok', { title: 'Mortgage tracker, deals and documents are shared' }, 'Shared finances') : null),
        h('div.muted.small', [r.contact.email, r.contact.mobile].filter(Boolean).join(' · ') || 'No contact details'),
        r.notes ? h('div.small', r.notes) : null,
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => editRelationship(c, r) }, 'Edit'),
          h('button.link.small.text-danger', { type: 'button', onclick: () => removeRelationship(c, r) }, 'Unlink')))))
      : h('p.empty', 'No related contacts. Link a partner to combine their finances and send joint documents.'));
}

async function linkContactDialog(c) {
  const { rows } = await api('/contacts?limit=1000');
  const linked = new Set(c.relationships.map((r) => r.contact.id));
  const others = rows.filter((o) => o.id !== c.id && !linked.has(o.id));

  const mode = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Who to link' });
  const existingFields = [{ name: 'related_id', label: 'Contact', type: 'select', full: true, options: others.map((o) => [o.id, `${fullName(o)}${o.email ? ` (${o.email})` : ''}`]) }];
  const newFields = [
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'mobile', label: 'Mobile' },
    { name: 'dob', label: 'Date of birth', type: 'date' },
  ];
  const relFields = [
    { name: 'relationship', label: 'Relationship', type: 'select', required: true, options: relOptions(), default: 'spouse' },
    { name: 'shared_finances', label: 'Shares finances with this contact (joint loans & properties)', type: 'checkbox', default: true, full: true },
    { name: 'copy_address', label: 'Copy the address to whoever doesn\'t have one', type: 'checkbox', default: true, full: true },
    { name: 'notes', label: 'Notes', full: true },
  ];

  const existingBox = h('div.grid-form', existingFields.map((f) => field(f)));
  const newBox = h('div.grid-form', newFields.map((f) => field(f, f.name === 'last_name' ? c.last_name : undefined)),
    h('p.muted.small.full', `Status, owner, lead source and address are copied from ${c.first_name}.`));
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

  const dialog = modal(`Link a contact to ${fullName(c)}`, [mode, form], { wide: true });
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
    { name: 'relationship', label: `${r.contact.first_name} is ${c.first_name}'s…`, type: 'select', required: true, options: relOptions() },
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

export const householdOf = async (contactId) => (contactId ? (await api(`/contacts/${contactId}/household`)).rows : []);
