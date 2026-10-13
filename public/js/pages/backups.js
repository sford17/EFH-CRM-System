// Settings → Backups (admins): status, "back up now", where and when, and the list.
import { api, h, table, badge, attempt, toast, state, dateTime } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const KINDS = { daily: ['automatic', 'info'], manual: ['manual', ''], update: ['before update', 'warn'] };
const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null);

export async function backupsCard() {
  if (state.user.role !== 'admin') return null;
  const { settings: s, backups } = await api('/backups');
  const age = daysSince(s.last_ok_at);
  const status = !s.enabled ? h('div.alert.warn-box', h('strong', 'Automatic backups are off. '), 'Switch them on below.')
    : s.last_error ? h('div.alert.danger', h('strong', 'The last backup didn\'t work. '), s.last_error)
      : !s.last_ok_at ? h('div.alert.info', 'No backups yet. The first runs tonight at ', s.time, ', or press "Back up now".')
        : h('div.alert.info', h('strong', `Last backup ${dateTime(s.last_ok_at)}`), age > 1 ? ` (${age} days ago)` : '', `. Next one at ${s.time}.`);

  const now = h('button', { type: 'button' }, 'Back up now');
  now.addEventListener('click', async () => {
    now.disabled = true;
    now.textContent = 'Backing up…';
    try {
      const r = await attempt(() => api('/backups/run', { method: 'POST', body: {} }));
      toast(`Backed up (${size(r.size)}, ${r.contacts} contacts)`);
      refresh();
    } catch {
      now.disabled = false;
      now.textContent = 'Back up now';
    }
  });

  const enabled = h('input', { type: 'checkbox', checked: s.enabled });
  const time = h('input', { type: 'time', value: s.time, required: true });
  const folder = h('input', { type: 'text', value: s.custom_folder ? s.folder : '', placeholder: s.default_folder || '', 'aria-label': 'Backup folder' });
  const days = h('input', { type: 'number', min: 1, max: 365, value: s.keep_days });
  const months = h('input', { type: 'number', min: 0, max: 120, value: s.keep_months });
  const form = h('form.grid-form',
    h('label.field.full.check', enabled, h('span', 'Back up automatically every day')),
    h('label.field', h('span', 'Time'), time),
    h('label.field.full', h('span', 'Backup folder'), folder,
      h('span.small.muted', 'Leave blank for the "backups" folder inside the data folder. Better: a folder that syncs to the cloud, e.g. C:\\Users\\you\\OneDrive\\CRM Backups, so a copy survives if this computer is lost or fails.')),
    h('label.field', h('span', 'Keep daily backups for (days)'), days),
    h('label.field', h('span', 'Also keep one a month for (months)'), months),
    h('div.actions.full', h('button', { type: 'submit' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await attempt(() => api('/backups/settings', { method: 'PUT', body: { enabled: enabled.checked, time: time.value, folder: folder.value, keep_days: Number(days.value), keep_months: Number(months.value) } }), 'Saved');
      refresh();
    } catch { /* toasted */ }
  });

  return h('section.card',
    h('div.card-head', h('h2', 'Backups'), now),
    status,
    s.enabled && s.same_drive ? h('div.alert.warn-box.small', h('strong', 'Backups are on this computer only. '), 'If the computer is lost, stolen or its drive fails, they go with it. Choose a OneDrive, Google Drive or Dropbox folder below (or a USB drive you take off-site).') : null,
    h('p.small.muted', `Each backup is a folder holding a copy of the database (clients, deals, documents and settings) and secret.key (which unlocks saved passwords and connections). Copies are checked after they're made. A backup is also made automatically before every update. Saving to: ${s.folder}`),
    form,
    h('h3', `Backups (${backups.length})`),
    table([
      { label: 'When', value: (b) => `${b.date.split('-').reverse().join('/')} ${b.time}` },
      { label: 'Type', value: (b) => badge(...(KINDS[b.kind] || [b.kind, ''])) },
      { label: 'Size', value: (b) => size(b.size), class: 'num' },
      { label: 'Download', value: (b) => (b.complete ? [h('a', { href: `/api/backups/${encodeURIComponent(b.name)}/crm.db`, download: '' }, 'crm.db'), b.files.includes('secret.key') ? [' · ', h('a', { href: `/api/backups/${encodeURIComponent(b.name)}/secret.key`, download: '' }, 'secret.key')] : null] : h('span.text-danger', 'incomplete')) },
    ], backups.slice(0, 40), { empty: 'No backups yet.' }),
    h('details.small',
      h('summary', 'How to restore a backup'),
      h('ol',
        h('li', 'Stop the CRM (close the window running npm start).'),
        h('li', 'In the CRM\'s data folder, rename crm.db to crm-old.db (and secret.key to secret-old.key) to keep them, just in case.'),
        h('li', 'Copy crm.db and secret.key from the backup folder into the data folder. Delete any crm.db-wal or crm.db-shm files left there.'),
        h('li', 'Start the CRM again (npm start).'))));
}
