// Quickli (servicing calculator): connection settings, and the Quickli card
// on each deal (send the deal as a scenario, see if it's ready, record results).
import { api, h, attempt, toast, modal, confirmDialog, badge, date, dateTime, money, state, field, readForm } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));

function copyButton(text, label = 'Copy') {
  return h('button.secondary.small', { type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied')) }, label);
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/x-pem-file' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---- Settings ------------------------------------------------------------------------------
export async function quickliSettingsCard() {
  const s = await api('/quickli/status');
  const isAdmin = state.user.role === 'admin';

  // Admin: the CRM's key and partner details.
  let admin = null;
  if (isAdmin) {
    const fields = [
      { name: 'partner_id', label: 'Integration partner ID (from Quickli)' },
      { name: 'key_id', label: 'Key ID (from Quickli, once the key is registered)' },
      { name: 'scenario_url', label: 'Scenario link (optional, with {id})', placeholder: 'https://…/{id}', full: true },
    ];
    const form = h('form.grid-form', fields.map((f) => field(f, s[f.name])), h('div.actions.full', h('button', { type: 'submit' }, 'Save')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await attempt(() => api('/quickli/config', { method: 'PUT', body: readForm(form, fields) }), 'Saved')) refresh();
    });
    const makeKey = async () => {
      if (s.has_key && !(await confirmDialog('Make a new key? The current one stops working, and the new public key needs registering with Quickli again.'))) return;
      if (await attempt(() => api('/quickli/key', { method: 'POST', body: {} }), 'Key created')) refresh();
    };
    const importKey = () => {
      const f = [{ name: 'private_key', label: 'Private key (PKCS#8, "BEGIN PRIVATE KEY")', type: 'textarea', rows: 8, full: true }];
      const fm = h('form.grid-form', f.map((x) => field(x)), h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Use this key')));
      const d = modal('Use an existing key', fm);
      fm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await attempt(() => api('/quickli/key', { method: 'POST', body: readForm(fm, f) }), 'Key saved')) { d.close(); refresh(); }
      });
    };
    admin = h('div.ql-admin',
      h('ol.setup-steps.small',
        h('li', 'Make the CRM\'s key: ', s.has_key ? badge('done', 'ok') : null, ' ',
          h('button.small', { type: 'button', onclick: makeKey }, s.has_key ? 'Make a new key' : 'Make a key'), ' ',
          h('button.link.small', { type: 'button', onclick: importKey }, 'or use an existing key')),
        h('li', 'Send the public key below to Quickli (support@quickli.com.au or your Quickli integration contact) and ask to connect your CRM to the Quickli External API (v3). They\'ll give you a partner ID and a key ID.'),
        h('li', 'Enter the partner ID and key ID below. Then each broker adds their own access token (next section).')),
      s.public_key ? h('div.ql-key', h('pre', s.public_key), h('div.actions', copyButton(s.public_key, 'Copy public key'), h('button.secondary.small', { type: 'button', onclick: () => download('efh-crm-quickli-public-key.pem', s.public_key) }, 'Download'))) : null,
      form);
  }

  // Each broker: their access token.
  const tokenFields = [{ name: 'token', label: s.token ? 'New access token' : 'Your Quickli access token', type: 'password', placeholder: 'From Quickli → Settings → Integrations' }];
  const tokenForm = h('form.grid-form', tokenFields.map((f) => field(f)), h('div.actions', h('button', { type: 'submit', disabled: !s.configured }, s.token ? 'Replace token' : 'Connect')));
  tokenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('/quickli/token', { method: 'PUT', body: readForm(tokenForm, tokenFields) }));
    if (r) { toast(r.ok ? 'Quickli connected' : r.error, r.ok ? 'ok' : 'error'); refresh(); }
  });
  const testIt = async () => {
    const r = await attempt(() => api('/quickli/test', { method: 'POST', body: {} }));
    if (r) toast(r.ok ? 'Quickli is connected' : r.error, r.ok ? 'ok' : 'error');
    refresh();
  };
  const remove = async () => {
    if (await confirmDialog('Remove your Quickli access token?')) { await attempt(() => api('/quickli/token', { method: 'DELETE' }), 'Removed'); refresh(); }
  };
  const t = s.token;
  const who = t?.whoami ? [t.whoami.broker?.name || t.whoami.name, t.whoami.broker?.email || t.whoami.email].filter(Boolean).join(' · ') : '';
  const mine = h('div.ql-mine',
    h('h3', 'Your connection'),
    !s.configured ? h('p.small.muted', 'An admin needs to finish the steps above first.') : null,
    t ? h('p.small', t.verified_at ? [badge('connected', 'ok'), ` ${who || ''} · checked ${dateTime(t.verified_at)}`] : [badge('not working', 'danger'), ` ${t.last_error || ''}`],
      ' ', h('button.link.small', { type: 'button', onclick: testIt }, 'Test'), ' ', h('button.link.small', { type: 'button', onclick: remove }, 'Remove')) : null,
    tokenForm);

  return h('section.card',
    h('div.card-head', h('h2', 'Quickli'), badge(s.configured ? (t?.verified_at ? 'connected' : 'set up') : 'not set up', s.configured && t?.verified_at ? 'ok' : '')),
    h('p.small.muted', 'Send a deal\'s borrowers, income, properties, loans and debts to Quickli as a servicing scenario, without retyping them.'),
    admin, mine);
}

// ---- Deal card -----------------------------------------------------------------------------
function resultsDialog(deal, link) {
  const r = link.results || {};
  const fields = [
    { name: 'max_borrowing', label: 'Maximum borrowing ($)', type: 'number' },
    { name: 'lenders_passing', label: 'Lenders that pass', type: 'number', step: 1 },
    { name: 'best_lender', label: 'Best lender' },
    { name: 'surplus', label: 'Monthly surplus ($)', type: 'number' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, full: true },
  ];
  const form = h('form.grid-form', h('p.small.muted.full', 'Copy the headline results from Quickli so they\'re on the deal.'), fields.map((f) => field(f, r[f.name])),
    h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Save')));
  const d = modal('Servicing results', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api(`/deals/${deal.id}/quickli/results`, { method: 'PUT', body: readForm(form, fields) }), 'Saved')) { d.close(); refresh(); }
  });
}

function linkDialog(deal) {
  const fields = [{ name: 'scenario_id', label: 'Scenario ID or link (from the address bar in Quickli)', required: true, full: true }];
  const form = h('form.grid-form', fields.map((f) => field(f)), h('div.actions.full', h('button.secondary', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button', { type: 'submit' }, 'Link')));
  const d = modal('Link an existing Quickli scenario', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api(`/deals/${deal.id}/quickli/link`, { method: 'POST', body: readForm(form, fields) }), 'Linked')) { d.close(); refresh(); }
  });
}

export async function quickliCard(deal) {
  const q = await api(`/deals/${deal.id}/quickli`);
  if (!q.configured && state.user.role !== 'admin') return null;
  const l = q.link;
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Sending…';
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
  const pushBtn = h('button.small', { type: 'button' }, l ? 'Update Quickli' : 'Send to Quickli');
  pushBtn.addEventListener('click', busy(pushBtn, async () => {
    const r = await attempt(() => api(`/deals/${deal.id}/quickli/push`, { method: 'POST', body: {} }));
    if (r) { toast(l ? 'Quickli scenario updated' : `Quickli scenario ${r.link.scenario_id} created`); refresh(); }
  }));
  const refreshBtn = h('button.link.small', { type: 'button', onclick: async () => { if (await attempt(() => api(`/deals/${deal.id}/quickli/refresh`, { method: 'POST', body: {} }), 'Checked')) refresh(); } }, 'Check again');
  const unlink = async () => {
    if (await confirmDialog('Unlink this deal from its Quickli scenario? (The scenario stays in Quickli.)')) { await attempt(() => api(`/deals/${deal.id}/quickli`, { method: 'DELETE' }), 'Unlinked'); refresh(); }
  };
  const res = l?.results;
  const tile = (k, v) => h('div.tile', h('div.tile-label', k), h('div.tile-value', v));
  const s = q.summary;
  const ready = l && l.calc_ready !== null ? (l.calc_ready ? badge('ready to calculate', 'ok') : badge(`${l.issues.length} thing${l.issues.length === 1 ? '' : 's'} to fix`, 'warn')) : null;

  return h('section.card.ql-card',
    h('div.card-head', h('h2', 'Quickli servicing ', ready),
      q.configured && q.connected ? h('div.actions', pushBtn, l ? h('button.small.secondary', { type: 'button', onclick: () => resultsDialog(deal, l) }, res ? 'Edit results' : 'Record results') : h('button.small.secondary', { type: 'button', onclick: () => linkDialog(deal) }, 'Link existing')) : null),
    !q.configured ? h('p.small.muted', 'Connect Quickli in Settings → Quickli to send this deal straight to a servicing scenario.')
      : !q.connected ? h('p.small.muted', 'Add your Quickli access token in Settings → Quickli to send this deal to Quickli.') : null,
    l ? h('p.small', 'Scenario ', h('strong.mono', l.scenario_id), ' ', copyButton(l.scenario_id), ' ',
      l.url ? h('a.button.secondary.small', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Quickli ↗') : null,
      h('span.muted', ` · ${l.pushed_at ? `sent ${dateTime(l.pushed_at)}${l.pushed_by_name ? ` by ${l.pushed_by_name}` : ''}` : 'linked'}`), ' ', refreshBtn, ' ', h('button.link.small', { type: 'button', onclick: unlink }, 'Unlink')) : null,
    l && l.issues.length ? h('div.alert.warn-box.small', h('strong', 'Quickli needs: '), h('ul', l.issues.map((i) => h('li', i)))) : null,
    res ? h('div.tiles.ql-results',
      tile('Max borrowing', res.max_borrowing ? money(res.max_borrowing) : '—'),
      tile('Lenders passing', res.lenders_passing ?? '—'),
      tile('Best lender', res.best_lender || '—'),
      tile('Monthly surplus', res.surplus !== null && res.surplus !== undefined ? money(res.surplus) : '—')) : null,
    res?.notes ? h('p.small', res.notes, h('span.muted', ` (recorded ${date(res.recorded_at)})`)) : null,
    h('details.ql-sent',
      h('summary.small', l ? 'What the CRM sends to Quickli' : 'What will be sent to Quickli'),
      h('dl.info',
        h('div.info-row', h('dt', 'Borrowers'), h('dd', `${s.borrowers.join(' & ')} · ${s.household}`)),
        h('div.info-row', h('dt', 'Income'), h('dd', s.income.join('; ') || '—')),
        h('div.info-row', h('dt', 'Properties'), h('dd', s.properties.join('; ') || '—')),
        h('div.info-row', h('dt', 'Existing loans'), h('dd', s.existing_loans.join('; ') || '—')),
        h('div.info-row', h('dt', 'Other debts'), h('dd', s.debts.join('; ') || '—')),
        h('div.info-row', h('dt', 'New loan'), h('dd', s.new_loan))),
      q.warnings.length ? h('div.small', h('strong', 'Add or check in Quickli:'), h('ul', q.warnings.map((w) => h('li', w)))) : null));
}
