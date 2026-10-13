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
    s.ignored_folder ? h('div.alert.info.small', `The backup folder saved earlier (${s.ignored_folder}) doesn't exist on this computer, so backups go to the standard folder. Choose another below if you like.`) : null,
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
    restoreSection(),
    h('details.small',
      h('summary', 'How to restore a backup by hand (if the CRM won\'t start)'),
      h('ol',
        h('li', 'Stop the CRM (close the window running npm start).'),
        h('li', 'In the CRM\'s data folder, rename crm.db to crm-old.db (and secret.key to secret-old.key) to keep them, just in case.'),
        h('li', 'Copy crm.db and secret.key from the backup folder into the data folder. Delete any crm.db-wal or crm.db-shm files left there.'),
        h('li', 'Start the CRM again (npm start).'))));
}

// Upload a backup's crm.db and secret.key and swap them in (e.g. moving to a new server).
function restoreSection() {
  const dbFile = h('input', { type: 'file', accept: '.db', 'aria-label': 'crm.db from the backup' });
  const keyFile = h('input', { type: 'file', accept: '.key', 'aria-label': 'secret.key from the backup' });
  const status = h('p.small', { role: 'status' });
  const go = h('button.danger', { type: 'button' }, 'Restore this backup');
  const upload = async (name, file) => {
    status.textContent = `Uploading ${name} (${(file.size / 1048576).toFixed(1)} MB)…`;
    const res = await fetch(`/api/backups/restore/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  };
  go.addEventListener('click', async () => {
    if (!dbFile.files[0]) { toast('Choose the crm.db file from the backup', 'error'); return; }
    const typed = window.prompt('This replaces everything in the CRM with the backup. A copy of what\'s here now is saved first.\n\nType RESTORE to continue.');
    if (typed !== 'RESTORE') return;
    go.disabled = true;
    try {
      await api('/backups/restore', { method: 'DELETE' });
      await upload('crm.db', dbFile.files[0]);
      if (keyFile.files[0]) await upload('secret.key', keyFile.files[0]);
      status.textContent = 'Checking and restoring…';
      const r = await api('/backups/restore/apply', { method: 'POST', body: {} });
      status.textContent = `Restored: ${r.contacts} contacts, ${r.users} users. Please sign in again.`;
      toast('Backup restored. Please sign in again.');
      setTimeout(() => { location.hash = '#/login'; location.reload(); }, 2500);
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
      go.disabled = false;
    }
  });
  return h('details.restore-box',
    h('summary', h('strong', 'Restore from a backup')),
    h('p.small.muted', 'Use this to move your CRM to a new computer or server, or to go back to an earlier backup. Choose the two files from one backup folder. Everything in the CRM now is replaced (a copy is saved first), and everyone signs in again with the backup\'s passwords.'),
    h('div.grid-form',
      h('label.field', h('span', 'crm.db'), dbFile),
      h('label.field', h('span', 'secret.key'), keyFile)),
    h('div.actions.mfa-left', go),
    status);
}
