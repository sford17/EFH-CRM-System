// The other professionals on a deal: real estate agent, solicitor/conveyancer,
// buyer's agent… Picked from the partners directory, or added on the spot.
import { api, h, attempt, modal, confirmDialog, state, loadLookups, field, readForm, toast } from '../core.js';

export const MAIN_ROLES = ['real_estate_agent', 'solicitor', 'buyers_agent'];
const NEW = '__new';
const roleInfo = (key) => state.meta.party_roles.find((r) => r.key === key);
const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

// A select of matching directory entries plus "Add new…", which opens
// name/company/email/mobile inputs. read() → null | { role, partner_id } | { role, new_partner }.
export function partyPicker(role, { current = null, compact = false } = {}) {
  const info = roleInfo(role);
  const matches = state.partners
    .filter((p) => (p.active || p.id === current) && info.types.includes(p.type))
    .sort((a, b) => a.name.localeCompare(b.name));
  const id = `party_${role}_${Math.random().toString(36).slice(2, 7)}`;
  const select = h('select', { id, name: `party_${role}` },
    h('option', { value: '' }, compact ? '—' : 'Not yet known'),
    matches.map((p) => h('option', { value: p.id, selected: p.id === current }, `${p.name}${p.company ? ` – ${p.company}` : ''}`)),
    h('option', { value: NEW }, `+ Add a new ${info.label.toLowerCase()}…`));
  const newFields = [
    { name: 'name', label: 'Name', required: true },
    { name: 'company', label: role === 'real_estate_agent' ? 'Agency' : role === 'solicitor' ? 'Firm' : 'Company' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'mobile', label: 'Mobile' },
  ];
  const newBox = h('div.party-new', newFields.map((f) => field({ ...f, required: false })));
  newBox.hidden = true;
  select.addEventListener('change', () => {
    newBox.hidden = select.value !== NEW;
    if (!newBox.hidden) newBox.querySelector('input').focus();
  });
  const el = h('div.party-picker', h('label', { for: id }, info.label), select, newBox);
  const read = () => {
    if (!select.value) return null;
    if (select.value !== NEW) return { role, partner_id: Number(select.value) };
    const v = Object.fromEntries(newFields.map((f) => [f.name, newBox.querySelector(`[name=${f.name}]`).value.trim()]));
    if (!v.name) {
      newBox.querySelector('[name=name]').focus();
      throw new Error(`Enter the ${info.label.toLowerCase()}'s name`);
    }
    return { role, new_partner: v };
  };
  return { el, read };
}

// The "Agent & solicitor" section of the New deal form.
export function partiesFieldset(roles = MAIN_ROLES) {
  const pickers = roles.map((r) => partyPicker(r));
  return {
    el: h('fieldset.parties-fieldset.full',
      h('legend', 'Agent, solicitor & buyer\'s agent (optional)'),
      h('div.parties-grid', pickers.map((p) => p.el))),
    read: () => pickers.map((p) => p.read()).filter(Boolean),
  };
}

function editParty(deal, role, existing) {
  const picker = partyPicker(role, { current: existing?.id ?? null });
  const notes = field({ name: 'notes', label: 'Notes (e.g. "deals with Sarah in the office")', full: true }, existing?.notes);
  const form = h('form', picker.el, notes,
    h('div.actions', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Save')));
  const d = modal(`${existing ? 'Change' : 'Add'} ${roleInfo(role).label.toLowerCase()}`, form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const party = picker.read();
      if (!party) throw new Error(`Choose the ${roleInfo(role).label.toLowerCase()}, or Cancel`);
      await attempt(() => api(`/deals/${deal.id}/parties/${role}`, { method: 'PUT', body: { ...party, ...readForm(form, [{ name: 'notes' }]) } }), 'Saved');
      await loadLookups(true);
      d.close();
      refresh();
    } catch (err) { if (!err.toasted) toast(err.message, 'error'); }
  });
}

// "Agent & solicitor" card on a deal.
export function partiesCard(deal, { compose }) {
  const byRole = Object.fromEntries(deal.parties.map((p) => [p.role, p]));
  const shown = [...MAIN_ROLES, ...deal.parties.map((p) => p.role).filter((r) => !MAIN_ROLES.includes(r))];
  const others = state.meta.party_roles.filter((r) => !shown.includes(r.key));
  const remove = async (p) => {
    if (!(await confirmDialog(`Remove ${p.name} as ${p.role_label.toLowerCase()} on this deal? They stay in your directory.`))) return;
    await attempt(() => api(`/deals/${deal.id}/parties/${p.role}`, { method: 'DELETE' }), 'Removed');
    refresh();
  };
  const addOther = others.length ? h('select.small', {
    'aria-label': 'Add another party',
    onchange: (e) => { if (e.target.value) editParty(deal, e.target.value); e.target.value = ''; },
  }, h('option', { value: '' }, '+ Other…'), others.map((r) => h('option', { value: r.key }, r.label))) : null;

  return h('section.card.parties-card',
    h('div.card-head', h('h2', 'Agent & solicitor'), addOther),
    h('ul.plain.party-list', shown.map((role) => {
      const p = byRole[role];
      const info = roleInfo(role);
      if (!p) {
        return h('li.party.empty', h('span.muted', info.label),
          h('button.link.small', { type: 'button', onclick: () => editParty(deal, role) }, `+ Add ${info.label.toLowerCase()}`));
      }
      return h('li.party',
        h('div.party-role.muted.small', p.role_label),
        h('div', h('strong', p.name), p.company ? h('span.muted', ` · ${p.company}`) : null),
        h('div.party-contact.small',
          p.email ? h('button.link.small', { type: 'button', onclick: () => compose(p) }, p.email) : null,
          [p.mobile, p.phone].filter(Boolean).map((n) => h('a', { href: `tel:${n.replace(/\s/g, '')}` }, n))),
        p.notes ? h('div.small', p.notes) : null,
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => editParty(deal, role, p) }, 'Change'),
          h('button.link.small', { type: 'button', onclick: () => remove(p) }, 'Remove')));
    })));
}
