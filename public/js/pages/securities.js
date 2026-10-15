// Rent rolls, General Security Agreements (GSA) and guarantees: securities that
// aren't property, for commercial and business loans (on a deal or a tracker loan).
import { api, h, formModal, attempt, confirmDialog, fullName } from '../core.js';

export const SECURITY_TYPES = { rent_roll: 'Rent roll', gsa: 'General Security Agreement (GSA)', guarantee: 'Guarantee' };
export const SECURITY_LOAN_TYPES = ['commercial', 'business_loan'];

let contactsCache = null;
const contactOptions = async () => {
  contactsCache = contactsCache || (await api('/contacts?limit=500')).rows;
  // Companies and trusts first: they usually grant a GSA or guarantee.
  return [...contactsCache].sort((a, b) => (a.entity_type === 'person') - (b.entity_type === 'person') || fullName(a).localeCompare(fullName(b)))
    .map((c) => [c.id, `${fullName(c)}${c.entity_type && c.entity_type !== 'person' ? ` (${c.entity_type})` : ''}`]);
};

function fieldsFor(type, people) {
  if (type === 'rent_roll') {
    return [
      { name: 'name', label: 'Rent roll (agency or business name)', full: true },
      { name: 'managements', label: 'Number of managements', type: 'number', step: 1 },
      { name: 'value', label: 'Value ($)', type: 'number' },
      { name: 'contact_id', label: 'Owned by (in the CRM, optional)', type: 'select', options: people },
      { name: 'description', label: 'Details (e.g. location, annual income)' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
  }
  if (type === 'gsa') {
    return [
      { name: 'contact_id', label: 'Grantor (company or trust in the CRM)', type: 'select', options: people },
      { name: 'name', label: 'Or grantor name' },
      { name: 'description', label: 'Secured property', full: true, placeholder: 'All present and after-acquired property' },
      { name: 'value', label: 'Value of secured assets ($, optional)', type: 'number' },
      { name: 'ppsr_number', label: 'PPSR registration number' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
  }
  return [
    { name: 'contact_id', label: 'Guarantor (in the CRM)', type: 'select', options: people },
    { name: 'name', label: 'Or guarantor name' },
    { name: 'limit_amount', label: 'Limit ($, blank = unlimited)', type: 'number' },
    { name: 'description', label: 'Kind (e.g. personal, director\'s, corporate)' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
  ];
}

// Add (type given) or change (existing given) one security. `parent` is { deal_id } or { loan_id }.
export async function securityDialog({ parent, type, existing = null, onSaved }) {
  const t = existing?.type || type;
  const people = await contactOptions();
  formModal(`${existing ? 'Edit' : 'Add'} ${t === 'gsa' ? SECURITY_TYPES.gsa : SECURITY_TYPES[t].toLowerCase()}`,
    fieldsFor(t, people), existing || (t === 'gsa' ? { description: 'All present and after-acquired property' } : {}), async (v) => {
      await attempt(() => (existing
        ? api(`/tracker/securities/${existing.id}`, { method: 'PATCH', body: v })
        : api('/tracker/securities', { method: 'POST', body: { ...parent, type: t, ...v } })), 'Saved');
      onSaved?.();
    }, { wide: false });
}

// The list with add/edit/remove. Shown for commercial and business loans (or when some exist).
export function securitiesSection({ items = [], parent, loanType, onChange, heading = true }) {
  const eligible = SECURITY_LOAN_TYPES.includes(loanType);
  if (!eligible && !items.length) return null;
  const remove = async (s) => {
    if (!(await confirmDialog(`Remove ${s.summary}?`))) return;
    await attempt(() => api(`/tracker/securities/${s.id}`, { method: 'DELETE' }), 'Removed');
    onChange?.();
  };
  return h('div.other-securities',
    heading ? h('h3', 'Other securities') : null,
    items.length
      ? h('ul.plain.security-list', items.map((s) => h('li',
        h('div', h('strong', s.label), s.contact_id ? [' – ', h('a', { href: `#/contacts/${s.contact_id}` }, s.contact_name)] : s.name ? ` – ${s.name}` : null),
        h('div.muted.small', [s.detail, s.description, s.ppsr_number ? `PPSR ${s.ppsr_number}` : null].filter(Boolean).join(' · ')),
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => securityDialog({ parent, existing: s, onSaved: onChange }) }, 'Edit'),
          h('button.link.small.text-danger', { type: 'button', onclick: () => remove(s) }, 'Remove')))))
      : h('p.muted.small', 'No rent roll, GSA or guarantee yet.'),
    eligible ? h('div.security-add', Object.entries(SECURITY_TYPES).map(([k, l]) => h('button.secondary.small', { type: 'button', onclick: () => securityDialog({ parent, type: k, onSaved: onChange }) }, `+ ${l.replace('General Security Agreement (GSA)', 'GSA')}`))) : null);
}
