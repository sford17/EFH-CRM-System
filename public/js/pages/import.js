// Spreadsheet import wizard: upload → match columns → preview → import (with undo).
import { api, h, pageHeader, table, attempt, toast, confirmDialog, dateTime, userOptions, state, badge, label } from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
let wizard = null; // { filename, sheets, sheetIndex, mapping, options, preview }

const readBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read that file'));
  r.readAsDataURL(file);
});

const STATUS_CHOICES = [['client', 'Client'], ['past_client', 'Past client'], ['prospect', 'Prospect'], ['lead', 'Lead']];
const STAGE_CHOICES = [['settled', 'Settled (existing loans)'], ['application_lodged', 'Application lodged'], ['pre_approval', 'Pre-approval'], ['lead', 'New lead']];

export async function importPage() {
  const view = h('div');
  const [{ fields }, history] = await Promise.all([api('/import/fields'), api('/import/history')]);
  const render = () => {
    if (!wizard) view.replaceChildren(uploadStep(history.rows));
    else if (!wizard.preview) view.replaceChildren(mappingStep(fields));
    else if (!wizard.result) view.replaceChildren(previewStep());
    else view.replaceChildren(doneStep());
  };
  view.addEventListener('wizard:render', render);
  render();
  return h('div', pageHeader('Import clients'), view);

  // ---- Step 1: upload ---------------------------------------------------------
  function uploadStep(rows) {
    const input = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv', hidden: true });
    const drop = h('div.dropzone', { tabindex: 0, role: 'button', 'aria-label': 'Choose a spreadsheet to import' },
      h('div.dropzone-icon', '⇪'),
      h('strong', 'Drop your spreadsheet here, or click to choose'),
      h('div.muted.small', 'Excel (.xlsx) or CSV · up to 20,000 rows'));
    const load = async (file) => {
      if (!file) return;
      drop.classList.add('busy');
      try {
        const data = await readBase64(file);
        const r = await attempt(() => api('/import/parse', { method: 'POST', body: { filename: file.name, data } }));
        const sheetIndex = Math.max(0, r.sheets.findIndex((s) => s.rows.length));
        wizard = {
          filename: file.name, sheets: r.sheets, sheetIndex, mapping: [...r.sheets[sheetIndex].mapping],
          options: {
            default_status: 'client', duplicates: 'skip', owner_id: state.user.id, tag: `imported-${new Date().toISOString().slice(0, 10)}`,
            loan_stage: 'settled', marketing_default: true, hold_due_automations: true,
          },
        };
        view.dispatchEvent(new Event('wizard:render'));
      } finally {
        drop.classList.remove('busy');
      }
    };
    input.addEventListener('change', () => load(input.files[0]));
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); });

    const undo = async (imp) => {
      if (!(await confirmDialog(`Undo the import of "${imp.filename}"? The ${imp.contacts_created} client(s) and ${imp.deals_created} loan(s) it created will be deleted, including anything added to them since. Details filled in on existing clients are not reverted.`))) return;
      const r = await attempt(() => api(`/import/${imp.id}/undo`, { method: 'POST', body: {} }));
      toast(`Removed ${r.contacts_removed} client(s) and ${r.deals_removed} loan(s)`);
      refresh();
    };
    return h('div',
      h('section.card',
        h('p', 'Bring your existing clients across from Excel, your old CRM or your aggregator\'s system. Include their current loans (lender, amount, rate, fixed-rate expiry, settlement date) and the CRM will start looking after reviews and fixed-rate expiries for them straight away.'),
        drop, input,
        h('p.muted.small', 'Tips: one client per row, with column headings in the first row. Not sure how to lay it out? ',
          h('a', { href: '/api/import/template.csv', download: 'client-import-template.csv' }, 'Download a template'), '.')),
      rows.length ? h('section.card', h('h2', 'Previous imports'), table([
        { label: 'When', value: (i) => dateTime(i.created_at) },
        { label: 'File', value: (i) => `${i.filename}${i.sheet ? ` (${i.sheet})` : ''}` },
        { label: 'By', value: (i) => i.user_name || '—' },
        { label: 'Result', value: (i) => `${i.contacts_created} added · ${i.contacts_updated} updated · ${i.deals_created} loans · ${i.skipped} skipped` },
        { label: '', value: (i) => (i.undone_at ? badge('undone') : h('button.link.small', { type: 'button', onclick: () => undo(i) }, 'Undo')) },
      ], rows)) : null);
  }

  // ---- Step 2: match columns ------------------------------------------------------
  function mappingStep(allFields) {
    const sheet = wizard.sheets[wizard.sheetIndex];
    const samples = (col) => sheet.rows.map((r) => r[col]).filter((v) => v !== null && String(v).trim() !== '').slice(0, 3);
    const fieldSelect = (col) => {
      const sel = h('select', { 'aria-label': `Field for column ${sheet.headers[col]}` },
        h('option', { value: '' }, "— Don't import —"),
        h('optgroup', { label: 'Client' }, allFields.filter((f) => f.group === 'contact').map((f) => h('option', { value: f.key, selected: wizard.mapping[col] === f.key }, f.label))),
        h('optgroup', { label: 'Loan' }, allFields.filter((f) => f.group === 'loan').map((f) => h('option', { value: f.key, selected: wizard.mapping[col] === f.key }, f.label))));
      sel.addEventListener('change', () => {
        // A field can only be used once: clear it from any other column.
        if (sel.value) wizard.mapping = wizard.mapping.map((m, i) => (i !== col && m === sel.value ? '' : m));
        wizard.mapping[col] = sel.value;
        view.dispatchEvent(new Event('wizard:render'));
      });
      return sel;
    };
    const opt = (key, el) => {
      el.addEventListener('change', () => { wizard.options[key] = el.type === 'checkbox' ? el.checked : el.value; });
      return el;
    };
    const select = (key, choices) => opt(key, h('select', {}, choices.map(([v, l]) => h('option', { value: v, selected: String(wizard.options[key]) === String(v) }, l))));
    const sheetPicker = wizard.sheets.length > 1
      ? h('div.field', h('span', 'Sheet'), (() => {
        const s = h('select', {}, wizard.sheets.map((sh, i) => h('option', { value: i, selected: i === wizard.sheetIndex }, `${sh.name} (${sh.rows.length} rows)`)));
        s.addEventListener('change', () => { wizard.sheetIndex = Number(s.value); wizard.mapping = [...wizard.sheets[wizard.sheetIndex].mapping]; view.dispatchEvent(new Event('wizard:render')); });
        return s;
      })())
      : null;
    const matched = wizard.mapping.filter(Boolean).length;

    const next = async () => {
      const body = payload();
      const preview = await attempt(() => api('/import/preview', { method: 'POST', body }));
      wizard.preview = preview;
      view.dispatchEvent(new Event('wizard:render'));
    };
    return h('div',
      h('section.card',
        h('div.card-head', h('h2', `1. Match your columns – ${wizard.filename}`), h('span.muted.small', `${sheet.rows.length} rows · ${matched} of ${sheet.headers.length} columns matched`)),
        sheetPicker,
        h('p.muted.small', 'We\'ve guessed which column is which. Check each one, and choose "Don\'t import" for anything you don\'t need.'),
        h('div.table-wrap', h('table.map-table',
          h('thead', h('tr', h('th', 'Your column'), h('th', 'Example values'), h('th', 'Import as'))),
          h('tbody', sheet.headers.map((hd, col) => h(`tr${wizard.mapping[col] ? '.mapped' : ''}`,
            h('td', h('strong', hd)),
            h('td.muted.small', samples(col).map((v) => h('div.sample', typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toPrecision(6))) : String(v)))),
            h('td', fieldSelect(col)))))))),
      h('section.card',
        h('h2', '2. Options'),
        h('div.grid-form',
          h('div.field', h('span', 'Status when the spreadsheet doesn\'t say'), select('default_status', STATUS_CHOICES)),
          h('div.field', h('span', 'Assign clients to'), select('owner_id', userOptions())),
          h('div.field', h('span', 'Clients already in the CRM (same email or mobile)'), select('duplicates', [['skip', 'Skip them'], ['update', 'Fill in their missing details']])),
          h('div.field', h('span', 'Imported loans are at stage'), select('loan_stage', STAGE_CHOICES)),
          h('div.field', h('span', 'Tag everyone imported'), opt('tag', h('input', { type: 'text', value: wizard.options.tag }))),
          h('div.field'),
          h('label.field.check.full', opt('marketing_default', h('input', { type: 'checkbox', checked: wizard.options.marketing_default })),
            'These clients are happy to receive marketing (birthday and review messages). Used when the spreadsheet has no marketing column.'),
          h('label.field.check.full', opt('hold_due_automations', h('input', { type: 'checkbox', checked: wizard.options.hold_due_automations })),
            'Don\'t send automatic messages for things already due at import (e.g. a fixed rate expiring next month, a review that\'s overdue, today\'s birthdays). Future dates still trigger as normal.')),
        h('p.muted.small', 'Imported clients never receive welcome emails or stage update texts.')),
      h('div.actions.wizard-actions',
        h('button.secondary', { type: 'button', onclick: () => { wizard = null; view.dispatchEvent(new Event('wizard:render')); } }, 'Start again'),
        h('button', { type: 'button', onclick: next }, 'Preview import →')));
  }

  function payload() {
    const sheet = wizard.sheets[wizard.sheetIndex];
    return { filename: wizard.filename, sheet: sheet.name, headers: sheet.headers, rows: sheet.rows, mapping: wizard.mapping, options: { ...wizard.options, owner_id: Number(wizard.options.owner_id) } };
  }

  // ---- Step 3: preview -----------------------------------------------------------------
  function previewStep() {
    const { summary, records } = wizard.preview;
    const tile = (l, v, kind = '') => h(`div.tile${kind ? `.${kind}` : ''}`, h('div.tile-label', l), h('div.tile-value', String(v)));
    const name = (r) => [r.contact.first_name, r.contact.last_name].filter(Boolean).join(' ') || h('span.text-danger', '(no name)');
    const loanText = (l) => (l ? [l.lender_name || l.new_lender, l.loan_amount ? `$${Number(l.loan_amount).toLocaleString('en-AU')}` : null,
      l.interest_rate ? `${l.interest_rate}%` : null, l.fixed_expiry_date ? `fixed to ${l.fixed_expiry_date}` : null].filter(Boolean).join(' · ') : '—');
    const actionBadge = (r) => badge(r.action === 'create' ? 'add' : r.action === 'update' ? 'update' : 'skip', r.action === 'create' ? 'ok' : r.action === 'update' ? 'info' : '');

    const commit = async () => {
      const btn = document.querySelector('.wizard-actions button:last-child');
      if (btn) btn.disabled = true;
      try {
        wizard.result = await attempt(() => api('/import/commit', { method: 'POST', body: payload() }));
        view.dispatchEvent(new Event('wizard:render'));
      } finally {
        if (btn) btn.disabled = false;
      }
    };
    return h('div',
      h('div.tiles',
        tile('Clients to add', summary.create, 'good'),
        tile('Existing clients to update', summary.update),
        tile('Loans to add', summary.loans),
        tile('Rows skipped', summary.skip),
        tile('Rows with warnings', summary.with_warnings)),
      summary.new_lenders.length ? h('div.alert.info', `New lenders will be added to your lender list: ${summary.new_lenders.join(', ')}. Set their commission rates on the Lenders page afterwards.`) : null,
      h('section.card',
        h('div.card-head', h('h2', 'Preview'), h('span.muted.small', records.length < summary.rows ? `Showing ${records.length} of ${summary.rows} rows – rows with problems first` : 'Rows with problems are shown first')),
        table([
          { label: 'Row', value: (r) => String(r.row), class: 'num' },
          { label: '', value: actionBadge },
          { label: 'Name', value: name },
          { label: 'Email / mobile', value: (r) => h('div.small', r.contact.email || '', r.contact.mobile ? h('div', r.contact.mobile) : null) },
          { label: 'Status', value: (r) => label(r.contact.status) },
          { label: 'Loan', value: (r) => h('div.small', loanText(r.loan)) },
          { label: 'Notes', value: (r) => h('div.small', r.errors.map((e) => h('div.text-danger', e)), r.warnings.map((w) => h('div.text-warn', w))) },
        ], records)),
      h('div.actions.wizard-actions',
        h('button.secondary', { type: 'button', onclick: () => { wizard.preview = null; view.dispatchEvent(new Event('wizard:render')); } }, '← Back to columns'),
        h('button', { type: 'button', disabled: !summary.create && !summary.update, onclick: commit }, `Import ${summary.create} client${summary.create === 1 ? '' : 's'}${summary.update ? ` and update ${summary.update}` : ''}`)));
  }

  // ---- Step 4: done ------------------------------------------------------------------------
  function doneStep() {
    const r = wizard.result;
    const tag = wizard.options.tag;
    const undo = async () => {
      if (!(await confirmDialog('Undo this import? Everyone it added will be deleted.'))) return;
      const u = await attempt(() => api(`/import/${r.import_id}/undo`, { method: 'POST', body: {} }));
      toast(`Removed ${u.contacts_removed} client(s) and ${u.deals_removed} loan(s)`);
      wizard = null;
      view.dispatchEvent(new Event('wizard:render'));
    };
    return h('section.card.import-done',
      h('h2', '✓ Import complete'),
      h('ul.plain',
        h('li', h('strong', r.contacts_created), ' clients added'),
        r.contacts_updated ? h('li', h('strong', r.contacts_updated), ' existing clients updated') : null,
        h('li', h('strong', r.deals_created), ' loans added'),
        r.skipped ? h('li', h('strong', r.skipped), ' rows skipped') : null,
        r.held_automations ? h('li', h('strong', r.held_automations), ' automatic messages held because they were already due') : null,
        r.new_lenders?.length ? h('li', 'New lenders added: ', r.new_lenders.join(', ')) : null),
      h('div.actions',
        tag ? h('a.button', { href: `#/contacts?tag=${encodeURIComponent(tag)}`, onclick: () => { wizard = null; } }, 'View imported clients') : null,
        h('button.secondary', { type: 'button', onclick: () => { wizard = null; view.dispatchEvent(new Event('wizard:render')); } }, 'Import another file'),
        h('button.danger.ghost', { type: 'button', onclick: undo }, 'Undo this import')));
  }
}
