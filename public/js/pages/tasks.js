import { api, h, pageHeader, userOptions, state, date, relDays, attempt, formModal, confirmDialog, todayStr } from '../core.js';
import { newTask, taskFields, refresh } from './forms.js';

const f = { status: 'open', assigned_to: 'me', due: '' };

export async function tasksPage() {
  const list = h('div');
  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const { rows } = await api(`/tasks?${qs}`);
    const today = todayStr();
    const groups = [
      ['Overdue', rows.filter((t) => t.status === 'open' && t.due_date && t.due_date < today)],
      ['Today', rows.filter((t) => t.status === 'open' && t.due_date === today)],
      ['Upcoming', rows.filter((t) => t.status === 'open' && t.due_date && t.due_date > today)],
      ['No due date', rows.filter((t) => t.status === 'open' && !t.due_date)],
      ['Completed', rows.filter((t) => t.status === 'done')],
    ].filter(([, r]) => r.length);
    list.replaceChildren(...(groups.length ? groups.map(([title, r]) => h('section.card',
      h('h2', `${title} (${r.length})`),
      h('ul.task-list', r.map((t) => h(`li${t.status === 'done' ? '.done' : ''}`,
        h('input', {
          type: 'checkbox', checked: t.status === 'done', 'aria-label': `Mark ${t.title} done`,
          onchange: async (e) => { await attempt(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: e.target.checked ? 'done' : 'open' } })); load(); },
        }),
        h('div.grow',
          h('div', t.title, t.priority === 'high' ? h('span.badge.danger', 'High') : null, t.automation_name ? h('span.badge', { title: t.automation_name }, '⚡ auto') : null),
          t.description ? h('div.small', t.description) : null,
          h('div.muted',
            t.due_date ? `${date(t.due_date)} (${relDays(t.due_date)})` : 'No due date',
            t.assigned_name ? ` · ${t.assigned_name}` : '',
            t.contact_name ? [' · ', h('a', { href: t.deal_id ? `#/deals/${t.deal_id}` : `#/contacts/${t.contact_id}` }, t.deal_title || t.contact_name)] : null)),
        h('div.row-actions',
          h('button.link.small', { type: 'button', onclick: () => formModal('Edit task', taskFields(), t, async (v) => { await attempt(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: v }), 'Saved'); load(); }, { wide: false }) }, 'Edit'),
          h('button.link.small', { type: 'button', onclick: async () => { if (await confirmDialog('Delete this task?')) { await attempt(() => api(`/tasks/${t.id}`, { method: 'DELETE' })); load(); } } }, 'Delete'))))))) : [h('p.empty', 'No tasks match. Nice work!')]));
  };
  const sel = (key, text, options) => {
    const el = h('select', { 'aria-label': text }, options.map(([v, l]) => h('option', { value: v, selected: String(f[key]) === String(v) }, l)));
    el.addEventListener('change', () => { f[key] = el.value; load(); });
    return el;
  };
  await load();
  return h('div',
    pageHeader('Tasks', h('button', { type: 'button', onclick: () => newTask() }, '+ New task')),
    h('div.filters',
      sel('assigned_to', 'Assigned to', [['me', 'My tasks'], ['', 'Everyone'], ...userOptions().filter(([id]) => id !== state.user.id)]),
      sel('status', 'Status', [['open', 'Open'], ['done', 'Completed'], ['all', 'All']]),
      sel('due', 'Due', [['', 'Any time'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due within 7 days']])),
    list);
}

