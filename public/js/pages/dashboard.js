import { api, h, money, compact, date, relDays, state, link, attempt, badge } from '../core.js';
import { barList } from '../charts.js';
import { upcomingCard } from './calendar.js';

const tile = (labelText, value, sub) => h('div.tile', h('div.tile-label', labelText), h('div.tile-value', value), sub ? h('div.tile-sub', sub) : null);

export async function dashboardPage() {
  const d = await api('/dashboard');
  const target = d.settlement_target;
  const progress = target ? Math.min(100, Math.round((d.settled_month.volume / target) * 100)) : null;

  const taskList = d.my_tasks.length
    ? h('ul.task-list', d.my_tasks.map((t) => {
      const overdue = t.due_date && t.due_date < new Date().toISOString().slice(0, 10);
      const box = h('input', {
        type: 'checkbox', 'aria-label': `Complete ${t.title}`,
        onchange: async () => {
          await attempt(() => api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } }), 'Task completed');
          box.closest('li').remove();
        },
      });
      return h('li', box, h('div',
        h('div', t.title, t.priority === 'high' ? badge('high', 'danger') : null),
        h('div.muted', t.contact_name ? link(t.deal_id ? `#/deals/${t.deal_id}` : `#/contacts/${t.contact_id}`, t.deal_title || t.contact_name) : null,
          ' · ', h(`span${overdue ? '.text-danger' : ''}`, t.due_date ? `${date(t.due_date)} (${relDays(t.due_date)})` : 'No due date'))));
    }))
    : h('p.empty', 'Nothing due this week. 🎉');

  return h('div',
    h('div.page-header', h('h1', `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${state.user.name.split(' ')[0]}`)),
    d.backup_warning ? h('div.alert.warn-box', h('strong', 'Backups: '), d.backup_warning, ' ', link('#/settings', 'Check Settings → Backups')) : null,
    h('div.tiles',
      tile('Open pipeline', `$${compact(d.pipeline.volume)}`, `${d.pipeline.count} deals`),
      tile('Settled this month', `$${compact(d.settled_month.volume)}`,
        target ? h('div', h('div.meter', h('div.meter-fill', { style: { width: `${progress}%` } })), `${progress}% of ${money(target)} target`) : `${d.settled_month.count} deals`),
      tile('Commission this month', money(d.commission_month.expected), `${money(d.commission_month.received)} received`),
      tile('New contacts this month', String(d.new_leads_month)),
      tile('Overdue tasks', String(d.overdue_tasks), d.overdue_tasks ? link('#/tasks', 'View tasks') : 'All on track')),
    h('div.grid-2',
      h('section.card', h('h2', 'My tasks (next 7 days)'), taskList),
      upcomingCard(d.appointments)),
    h('div.grid-2',
      h('section.card', h('h2', 'Key dates'),
        d.key_dates.length
          ? h('ul.date-list', d.key_dates.map((k) => h('li',
            h('div.date-chip', h('strong', new Date(`${k.date}T00:00:00`).getDate()), h('span', new Date(`${k.date}T00:00:00`).toLocaleString('en-AU', { month: 'short' }))),
            h('div', h('div', k.label), h('div.muted', link(k.deal_id ? `#/deals/${k.deal_id}` : `#/contacts/${k.contact_id}?tab=tracker`, k.title), ` · ${relDays(k.date)}`)))))
          : h('p.empty', 'No finance, settlement or expiry dates coming up.')),
      h('section.card', h('h2', 'Pipeline by stage (loan volume)'),
        barList(d.by_stage.map((s) => ({ label: s.label, value: s.volume, note: `${s.count} deal${s.count === 1 ? '' : 's'}` })), { format: money }))),
    h('section.card.mt', h('h2', 'Recent activity'),
        d.recent_activity.length
          ? h('ul.activity-list.compact', d.recent_activity.map((a) => h('li',
            h('span.act-type', a.type), ' ',
            a.contact_id ? link(`#/contacts/${a.contact_id}`, a.contact_name) : null, ' ', a.body,
            h('div.muted', `${date(a.created_at)}${a.user_name ? ` · ${a.user_name}` : ''}`))))
          : h('p.empty', 'No activity yet.')));
}

