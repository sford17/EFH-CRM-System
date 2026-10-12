// Mortgage tracker tab on a contact: position summary, lending-structure
// diagram, properties & valuations, loans and other assets.
import {
  api, h, attempt, formModal, modal, confirmDialog, field, readForm, money, date, pct, label, opts, badge, lenderOptions, todayStr, lenderLogo,
} from '../core.js';

const refresh = () => window.dispatchEvent(new Event('crm:refresh'));
const compactMoney = (n) => (n === null || n === undefined ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}m` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : money(n));
const PROPERTY_TYPES = ['house', 'unit', 'townhouse', 'land', 'rural', 'commercial', 'other'];
const USAGES = ['owner_occupied', 'investment', 'holiday', 'vacant', 'business', 'other'];
const LOAN_TYPES = ['home_loan', 'investment_loan', 'line_of_credit', 'construction', 'bridging', 'commercial', 'personal', 'car', 'credit_card', 'hecs', 'other'];
const ASSET_TYPES = ['savings', 'superannuation', 'shares', 'vehicle', 'business', 'contents', 'other'];
const LOAN_LABELS = { home_loan: 'Home loan', investment_loan: 'Investment loan', line_of_credit: 'Line of credit', credit_card: 'Credit card', hecs: 'HECS-HELP' };
const loanType = (t) => LOAN_LABELS[t] || label(t);
const shortAddress = (a) => String(a || '').split(',')[0];

let methodFilter = '';

export async function trackerTab(contact) {
  const data = await api(`/tracker/contacts/${contact.id}`);
  const { totals, structure, properties, loans, assets, valuation_methods: methods } = data;
  const tile = (l, v, sub) => h('div.tile', h('div.tile-label', l), h('div.tile-value', v), sub ? h('div.tile-sub', sub) : null);
  const lvrKind = (lvr) => (lvr === null ? '' : lvr > 90 ? 'danger' : lvr > 80 ? 'warn' : 'ok');

  // ---- Lending structure diagram --------------------------------------------------------
  function lendingStructure(s) {
    if (!s.lenders.length && !s.properties.length) {
      return h('section.card', h('h2', 'Lending structure'), h('p.empty', 'Add properties and loans below to see how this client\'s lending is structured.'));
    }
    const propName = new Map(s.properties.map((p) => [p.id, shortAddress(p.address)]));
    const loanEls = new Map();
    const propEls = new Map();
    const loansCol = h('div.ls-col.ls-loans', h('div.ls-col-title', 'Lenders & loans'),
      s.lenders.map((g) => h('div.ls-lender',
        h('header', h('span.lender-tag', lenderLogo(g.logo_id, g.name), h('strong', g.name)), h('span', compactMoney(g.total))),
        g.loans.map((n) => {
          const el = h(`div.ls-loan${n.cross_collateralised ? '.cross' : ''}`, { tabindex: 0, dataset: { loan: n.id } },
            h('div.ls-loan-top', h('span', loanType(n.loan_type)), h('strong', compactMoney(n.owing))),
            h('div.small.muted', [n.interest_rate ? `${n.interest_rate}%` : null, n.rate_type === 'fixed' && n.fixed_expiry_date ? `fixed to ${date(n.fixed_expiry_date)}` : label(n.rate_type),
              n.repayment_type === 'io' ? `IO${n.io_expiry_date ? ` to ${date(n.io_expiry_date)}` : ''}` : null].filter(Boolean).join(' · ')),
            n.offset_balance ? h('div.small.muted', `Offset ${compactMoney(n.offset_balance)}`) : null,
            h('div.ls-secured.small', n.unsecured ? badge('unsecured') : ['Secured by ', n.security_ids.map((id) => propName.get(id)).filter(Boolean).join(' + ')],
              n.cross_collateralised ? badge('cross-collateralised', 'warn') : null));
          loanEls.set(n.id, { el, loan: n });
          return el;
        }))));
    const propsCol = h('div.ls-col.ls-props', h('div.ls-col-title', 'Properties (security)'),
      s.properties.map((p) => {
        const kind = lvrKind(p.lvr);
        const el = h('div.ls-prop', { tabindex: 0, dataset: { prop: p.id } },
          h('div.ls-loan-top', h('strong', shortAddress(p.address)), h('span', compactMoney(p.current_value))),
          h('div.small.muted', [label(p.usage), p.current_valuation ? `${p.current_valuation.method_label}, ${date(p.current_valuation.valuation_date)}` : 'No valuation'].join(' · ')),
          p.loan_ids.length
            ? h('div',
              h('div.lvr-meter', { role: 'img', 'aria-label': `LVR ${p.lvr ?? 'unknown'}%` },
                h(`div.lvr-fill.${kind}`, { style: { width: `${Math.min(100, p.lvr || 0)}%` } }), h('div.lvr-mark')),
              h('div.small', h('strong', p.lvr === null ? 'LVR —' : `LVR ${p.lvr}%`), ` · owing ${compactMoney(p.secured_debt)} · usable equity ${compactMoney(p.usable_equity)}`))
            : h('div.small.text-ok', 'Unencumbered – no lending secured'));
        propEls.set(p.id, el);
        return el;
      }));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ls-lines');
    svg.setAttribute('aria-hidden', 'true');
    const diagram = h('div.ls', loansCol, h('div.ls-gap'), propsCol, svg);

    const draw = () => {
      svg.replaceChildren();
      if (!diagram.isConnected || diagram.clientWidth < 640) return;
      const box = diagram.getBoundingClientRect();
      svg.setAttribute('width', box.width);
      svg.setAttribute('height', box.height);
      for (const { el, loan } of loanEls.values()) {
        for (const pid of loan.security_ids) {
          const target = propEls.get(pid);
          if (!target) continue;
          const a = el.getBoundingClientRect();
          const b = target.getBoundingClientRect();
          const x1 = a.right - box.left;
          const y1 = a.top + a.height / 2 - box.top;
          const x2 = b.left - box.left;
          const y2 = b.top + b.height / 2 - box.top;
          const mid = (x1 + x2) / 2;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
          path.setAttribute('class', `ls-line${loan.cross_collateralised ? ' cross' : ''}`);
          path.dataset.loan = loan.id;
          path.dataset.prop = pid;
          svg.append(path);
          for (const [x, y] of [[x1, y1], [x2, y2]]) {
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', x);
            dot.setAttribute('cy', y);
            dot.setAttribute('r', 4);
            dot.setAttribute('class', `ls-dot${loan.cross_collateralised ? ' cross' : ''}`);
            dot.dataset.loan = loan.id;
            dot.dataset.prop = pid;
            svg.append(dot);
          }
        }
      }
    };
    // Hovering a loan or property highlights what it's connected to.
    const highlight = (attr, id) => {
      diagram.classList.toggle('focusing', id !== null);
      diagram.querySelectorAll('.lit').forEach((n) => n.classList.remove('lit'));
      if (id === null) return;
      const lines = [...svg.querySelectorAll(`[data-${attr}="${id}"]`)];
      lines.forEach((l) => l.classList.add('lit'));
      const linked = new Set(lines.map((l) => `${attr === 'loan' ? 'prop' : 'loan'}:${l.dataset[attr === 'loan' ? 'prop' : 'loan']}`));
      diagram.querySelectorAll('[data-loan], [data-prop]').forEach((n) => {
        if (n.tagName === 'path' || n.tagName === 'circle') return;
        const key = n.dataset.loan ? `loan:${n.dataset.loan}` : `prop:${n.dataset.prop}`;
        if (key === `${attr}:${id}` || linked.has(key)) n.classList.add('lit');
      });
    };
    for (const [id, { el }] of loanEls) {
      el.addEventListener('mouseenter', () => highlight('loan', id));
      el.addEventListener('focus', () => highlight('loan', id));
      el.addEventListener('mouseleave', () => highlight('loan', null));
      el.addEventListener('blur', () => highlight('loan', null));
    }
    for (const [id, el] of propEls) {
      el.addEventListener('mouseenter', () => highlight('prop', id));
      el.addEventListener('focus', () => highlight('prop', id));
      el.addEventListener('mouseleave', () => highlight('prop', null));
      el.addEventListener('blur', () => highlight('prop', null));
    }
    new ResizeObserver(() => requestAnimationFrame(draw)).observe(diagram);

    const t = s.totals;
    return h('section.card',
      h('div.card-head', h('h2', 'Lending structure'), h('span.muted.small', 'Lines show which property secures each loan')),
      diagram,
      h('div.ls-totals',
        h('div', h('span.muted', 'Security value'), h('strong', compactMoney(t.property_value))),
        h('div', h('span.muted', 'Secured lending'), h('strong', compactMoney(t.secured_debt))),
        h('div', h('span.muted', 'Overall LVR'), h('strong', t.lvr === null ? '—' : `${t.lvr}%`)),
        h('div', h('span.muted', 'Equity'), h('strong', compactMoney(t.equity))),
        h('div', h('span.muted', 'Usable equity (80%)'), h('strong', compactMoney(t.usable_equity))),
        t.offsets ? h('div', h('span.muted', 'In offset'), h('strong', compactMoney(t.offsets))) : null));
  }

  // ---- Properties & valuations -------------------------------------------------------------
  function propertyFields() {
    return [
      { name: 'address', label: 'Address', required: true, full: true },
      { name: 'suburb', label: 'Suburb' },
      { name: 'state', label: 'State', type: 'select', options: ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'].map((x) => [x, x]) },
      { name: 'postcode', label: 'Postcode' },
      { name: 'property_type', label: 'Property type', type: 'select', options: opts(PROPERTY_TYPES), required: true, default: 'house' },
      { name: 'usage', label: 'Use', type: 'select', options: opts(USAGES), required: true, default: 'owner_occupied' },
      { name: 'bedrooms', label: 'Bedrooms', type: 'number', step: 1 },
      { name: 'status', label: 'Status', type: 'select', options: [['owned', 'Owned'], ['purchasing', 'Purchasing'], ['sold', 'Sold']], required: true, default: 'owned' },
      { name: 'purchase_date', label: 'Purchase date', type: 'date' },
      { name: 'purchase_price', label: 'Purchase price ($)', type: 'number' },
      { name: 'rental_income_weekly', label: 'Rent ($ per week)', type: 'number' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
  }
  function valuationFields() {
    return [
      { name: 'method', label: 'Valuation method', type: 'select', required: true, options: methods.map((m) => [m.key, m.label]), default: 'avm' },
      { name: 'valuation_date', label: 'Date', type: 'date', required: true, default: todayStr() },
      { name: 'amount', label: 'Value ($)', type: 'number', required: true },
      { name: 'provider', label: 'Provider / valuer (e.g. CoreLogic, Herron Todd White)' },
      { name: 'lender_id', label: 'Ordered by lender', type: 'select', options: lenderOptions },
      { name: 'reference', label: 'Reference / job number' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
  }
  const addProperty = () => {
    const fields = [...propertyFields(),
      { name: 'v_amount', label: 'Current value ($, optional)', type: 'number' },
      { name: 'v_method', label: 'Where the value came from', type: 'select', options: methods.map((m) => [m.key, m.label]), default: 'client_estimate' }];
    formModal('Add property', fields, {}, async (v) => {
      const { v_amount: amount, v_method: method, ...rest } = v;
      await attempt(() => api('/tracker/properties', { method: 'POST', body: { ...rest, contact_id: contact.id, valuation: amount ? { amount, method } : undefined } }), 'Property added');
      refresh();
    });
  };
  const editProperty = (p) => formModal(`Edit ${shortAddress(p.address)}`, propertyFields(), p, async (v) => {
    await attempt(() => api(`/tracker/properties/${p.id}`, { method: 'PATCH', body: v }), 'Saved');
    refresh();
  });
  const deleteProperty = async (p) => {
    if (!(await confirmDialog(`Delete ${p.address} and its valuation history? Loans it secures will be kept but no longer linked to it.`))) return;
    await attempt(() => api(`/tracker/properties/${p.id}`, { method: 'DELETE' }), 'Property deleted');
    refresh();
  };
  const addValuation = (p) => formModal(`New valuation – ${shortAddress(p.address)}`, valuationFields(), {}, async (v) => {
    await attempt(() => api(`/tracker/properties/${p.id}/valuations`, { method: 'POST', body: v }), 'Valuation added');
    refresh();
  });
  const editValuation = (v) => formModal('Edit valuation', valuationFields(), v, async (vals) => {
    await attempt(() => api(`/tracker/valuations/${v.id}`, { method: 'PATCH', body: vals }), 'Saved');
    refresh();
  });
  const deleteValuation = async (v) => {
    if (!(await confirmDialog(`Delete the ${v.method_label.toLowerCase()} of ${money(v.amount)} from ${date(v.valuation_date)}?`))) return;
    await attempt(() => api(`/tracker/valuations/${v.id}`, { method: 'DELETE' }), 'Deleted');
    refresh();
  };

  function propertiesCard(c, props, valuationMethods) {
    const filter = h('select', { 'aria-label': 'Show valuations by method' },
      h('option', { value: '' }, 'All valuation methods'),
      valuationMethods.map((m) => h('option', { value: m.key, selected: methodFilter === m.key }, m.label)));
    filter.addEventListener('change', () => { methodFilter = filter.value; refresh(); });
    const change = (v) => (v.change === null ? '' : h(`span.${v.change >= 0 ? 'text-ok' : 'text-danger'}`, `${v.change >= 0 ? '▲' : '▼'} ${money(Math.abs(v.change))} (${v.change_pct}%)`));

    return h('section.card',
      h('div.card-head', h('h2', `Properties (${props.length})`),
        h('div.actions', props.some((p) => p.valuations.length) ? filter : null, h('button.small', { type: 'button', onclick: addProperty }, '+ Property'))),
      props.length ? props.map((p) => {
        const vals = p.valuations.filter((v) => !methodFilter || v.method === methodFilter);
        return h(`article.prop-card${p.status === 'sold' ? '.sold' : ''}`,
          h('div.prop-head',
            h('div', h('h3', p.address, ' ', p.status !== 'owned' ? badge(p.status, p.status === 'sold' ? '' : 'info') : null),
              h('div.muted.small', [label(p.property_type), label(p.usage), p.bedrooms ? `${p.bedrooms} bed` : null,
                p.co_owner_name ? `co-owned with ${p.co_owner_name}` : null].filter(Boolean).join(' · '))),
            h('div.actions',
              h('button.small', { type: 'button', onclick: () => addValuation(p) }, '+ Valuation'),
              h('button.secondary.small', { type: 'button', onclick: () => editProperty(p) }, 'Edit'),
              h('button.icon.small', { type: 'button', 'aria-label': `Delete ${p.address}`, onclick: () => deleteProperty(p) }, '×'))),
          h('div.prop-facts',
            h('div', h('span.muted', 'Current value'), h('strong', money(p.current_value)),
              p.current_valuation ? h('span.muted.small', `${p.current_valuation.method_label} · ${date(p.current_valuation.valuation_date)}`) : null),
            p.purchase_price ? h('div', h('span.muted', 'Purchased'), h('strong', money(p.purchase_price)), h('span.muted.small', p.purchase_date ? date(p.purchase_date) : '')) : null,
            p.purchase_price && p.current_value ? h('div', h('span.muted', 'Growth'), h('strong', `${Math.round(((p.current_value - p.purchase_price) / p.purchase_price) * 1000) / 10}%`), h('span.muted.small', money(p.current_value - p.purchase_price))) : null,
            p.rental_income_weekly ? h('div', h('span.muted', 'Rent'), h('strong', `${money(p.rental_income_weekly)}/wk`), h('span.muted.small', `${money(p.rental_income_weekly * 52)} p.a.`)) : null),
          p.latest_by_method.length > 1 ? h('div.method-chips', h('span.muted.small', 'Latest by method:'),
            p.latest_by_method.map((v) => h('span.method-chip', h('span', v.method_label), h('strong', compactMoney(v.amount)), h('span.muted', date(v.valuation_date))))) : null,
          vals.length
            ? h('div.table-wrap', h('table.val-table',
              h('thead', h('tr', ['Date', 'Method', 'Value', 'Change', 'Provider', 'Lender', ''].map((t) => h('th', t)))),
              h('tbody', vals.map((v) => h('tr',
                h('td', date(v.valuation_date)),
                h('td', h(`span.method.m-${v.method}`, v.method_label)),
                h('td.num', money(v.amount)),
                h('td.small', change(v)),
                h('td.small', [v.provider, v.reference].filter(Boolean).join(' · ') || '—'),
                h('td.small', v.lender_name || '—'),
                h('td', h('div.row-actions',
                  h('button.link.small', { type: 'button', onclick: () => editValuation(v) }, 'Edit'),
                  h('button.link.small', { type: 'button', onclick: () => deleteValuation(v) }, 'Delete'))))))))
            : h('p.empty', methodFilter ? 'No valuations of this type.' : 'No valuations yet.'));
      }) : h('p.empty', 'No properties yet. Add the client\'s home and any investments.'));
  }

  // ---- Loans ---------------------------------------------------------------------------------
  function loanDialog(loan, props) {
    const fields = [
      { name: 'lender_id', label: 'Lender', type: 'select', options: lenderOptions },
      { name: 'lender_name', label: 'Or lender name (if not in your list)' },
      { name: 'loan_type', label: 'Loan type', type: 'select', options: LOAN_TYPES.map((t) => [t, loanType(t)]), required: true, default: 'home_loan' },
      { name: 'status', label: 'Status', type: 'select', options: [['active', 'Active'], ['refinanced', 'Refinanced'], ['discharged', 'Paid off / discharged']], required: true, default: 'active' },
      { name: 'account_number', label: 'Account / loan number' },
      { name: 'product_name', label: 'Product' },
      { name: 'limit_amount', label: 'Limit / original amount ($)', type: 'number' },
      { name: 'balance', label: 'Current balance ($)', type: 'number' },
      { name: 'balance_date', label: 'Balance as at', type: 'date', default: todayStr() },
      { name: 'offset_balance', label: 'Offset balance ($)', type: 'number' },
      { name: 'interest_rate', label: 'Interest rate (%)', type: 'number', step: 0.01 },
      { name: 'rate_type', label: 'Rate type', type: 'select', options: opts(['variable', 'fixed', 'split']), required: true, default: 'variable' },
      { name: 'fixed_expiry_date', label: 'Fixed rate expiry', type: 'date' },
      { name: 'repayment_type', label: 'Repayments', type: 'select', options: [['pi', 'Principal & interest'], ['io', 'Interest only']], required: true, default: 'pi' },
      { name: 'io_expiry_date', label: 'Interest-only ends', type: 'date' },
      { name: 'repayment_amount', label: 'Repayment amount ($)', type: 'number' },
      { name: 'repayment_frequency', label: 'Repayment frequency', type: 'select', options: opts(['monthly', 'fortnightly', 'weekly']), required: true, default: 'monthly' },
      { name: 'settlement_date', label: 'Settlement date', type: 'date' },
      { name: 'loan_term_years', label: 'Term (years)', type: 'number', step: 1 },
      { name: 'arranged_by_us', label: 'We arranged this loan', type: 'checkbox', default: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
    const current = new Set(loan?.security_ids || []);
    const securities = h('fieldset.securities.full', h('legend', 'Secured by'),
      props.filter((p) => p.status !== 'sold' || current.has(p.id)).length
        ? props.filter((p) => p.status !== 'sold' || current.has(p.id)).map((p) => h('label.field.check', h('input', { type: 'checkbox', value: p.id, checked: current.has(p.id) }), p.address))
        : h('p.muted.small', 'No properties yet – add one first, or leave this loan unsecured (e.g. a car loan or credit card).'));
    const form = h('form.grid-form', fields.map((f) => field(f, loan?.[f.name])), securities,
      h('div.actions.full',
        loan ? h('button.danger.ghost', { type: 'button', onclick: async () => {
          if (!(await confirmDialog('Delete this loan from the tracker?'))) return;
          await attempt(() => api(`/tracker/loans/${loan.id}`, { method: 'DELETE' }), 'Loan deleted');
          d.close();
          refresh();
        } }, 'Delete') : null,
        h('button', { type: 'submit' }, loan ? 'Save loan' : 'Add loan')));
    const d = modal(loan ? `${loan.lender_display} ${loanType(loan.loan_type).toLowerCase()}` : 'Add loan', form, { wide: true });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { ...readForm(form, fields), security_ids: [...securities.querySelectorAll('input:checked')].map((i) => Number(i.value)) };
      try {
        await attempt(() => api(loan ? `/tracker/loans/${loan.id}` : '/tracker/loans', { method: loan ? 'PATCH' : 'POST', body: loan ? body : { ...body, contact_id: contact.id } }), loan ? 'Saved' : 'Loan added');
        d.close();
        refresh();
      } catch { /* toast already shown */ }
    });
  }

  function loansCard(c, list, props) {
    const propName = new Map(props.map((p) => [p.id, shortAddress(p.address)]));
    return h('section.card',
      h('div.card-head', h('h2', `Loans (${list.filter((n) => n.status === 'active').length} active)`),
        h('button.small', { type: 'button', onclick: () => loanDialog(null, props) }, '+ Loan')),
      list.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Lender', 'Type', 'Balance', 'Rate', 'Repayments', 'Secured by', 'Status'].map((t) => h('th', t)))),
        h('tbody', list.map((n) => h(`tr.clickable${n.status !== 'active' ? '.inactive' : ''}`, { onclick: () => loanDialog(n, props) },
          h('td', h('span.lender-tag', lenderLogo(n.lender_logo_id, n.lender_display), h('strong', n.lender_display)), n.account_number ? h('div.muted.small', n.account_number) : null, !n.arranged_by_us ? h('div.muted.small', 'not arranged by us') : null),
          h('td', loanType(n.loan_type), n.co_borrower_name ? h('div.muted.small', `with ${n.co_borrower_name}`) : null),
          h('td.num', money(n.balance ?? n.limit_amount), n.limit_amount && n.balance !== null && n.balance !== n.limit_amount ? h('div.muted.small', `limit ${compactMoney(n.limit_amount)}`) : null,
            n.balance_date ? h('div.muted.small', `as at ${date(n.balance_date)}`) : null, n.offset_balance ? h('div.muted.small', `offset ${compactMoney(n.offset_balance)}`) : null),
          h('td', n.interest_rate ? pct(n.interest_rate) : '—', h('div.muted.small', n.rate_type === 'fixed' || n.rate_type === 'split'
            ? `${label(n.rate_type)}${n.fixed_expiry_date ? ` to ${date(n.fixed_expiry_date)}` : ''}` : 'Variable')),
          h('td', n.repayment_type === 'io' ? 'Interest only' : 'P&I', n.io_expiry_date && n.repayment_type === 'io' ? h('div.muted.small', `IO ends ${date(n.io_expiry_date)}`) : null,
            n.repayment_amount ? h('div.muted.small', `${money(n.repayment_amount)} ${n.repayment_frequency}`) : null),
          h('td.small', n.security_ids.length ? n.security_ids.map((id) => propName.get(id)).join(' + ') : badge('unsecured'),
            n.security_ids.length > 1 ? h('div', badge('cross-collateralised', 'warn')) : null),
          h('td', badge(n.status, n.status === 'active' ? 'ok' : ''))))))) : h('p.empty', 'No loans recorded yet.'));
  }

  // ---- Other assets -------------------------------------------------------------------------------
  function assetsCard(c, list) {
    const fields = [
      { name: 'asset_type', label: 'Type', type: 'select', options: opts(ASSET_TYPES), required: true, default: 'savings' },
      { name: 'description', label: 'Description' },
      { name: 'institution', label: 'Held with (bank, fund…)' },
      { name: 'value', label: 'Value ($)', type: 'number' },
      { name: 'value_date', label: 'Value as at', type: 'date', default: todayStr() },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ];
    const edit = (a) => formModal(a ? 'Edit asset' : 'Add asset', fields, a || {}, async (v) => {
      await attempt(() => api(a ? `/tracker/assets/${a.id}` : '/tracker/assets', { method: a ? 'PATCH' : 'POST', body: a ? v : { ...v, contact_id: contact.id } }), 'Saved');
      refresh();
    }, { wide: false });
    const remove = async (a) => {
      if (!(await confirmDialog('Delete this asset?'))) return;
      await attempt(() => api(`/tracker/assets/${a.id}`, { method: 'DELETE' }), 'Deleted');
      refresh();
    };
    const total = list.reduce((s, a) => s + (a.value || 0), 0);
    return h('section.card',
      h('div.card-head', h('h2', `Other assets${total ? ` · ${compactMoney(total)}` : ''}`), h('button.small', { type: 'button', onclick: () => edit(null) }, '+ Asset')),
      list.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Type', 'Description', 'Held with', 'Value', 'As at', ''].map((t) => h('th', t)))),
        h('tbody', list.map((a) => h('tr.clickable', { onclick: () => edit(a) },
          h('td', label(a.asset_type)), h('td', a.description || '—'), h('td', a.institution || '—'),
          h('td.num', money(a.value)), h('td', date(a.value_date)),
          h('td', h('button.link.small', { type: 'button', onclick: (e) => { e.stopPropagation(); remove(a); } }, 'Delete'))))))) : h('p.empty', 'Savings, super, shares, vehicles and other assets go here.'));
  }

  return h('div.tracker',
    h('div.tiles',
      tile('Property value', compactMoney(totals.property_value), `${structure.properties.length} propert${structure.properties.length === 1 ? 'y' : 'ies'}`),
      tile('Total lending', compactMoney(totals.total_debt), totals.unsecured_debt ? `incl. ${compactMoney(totals.unsecured_debt)} unsecured` : `${loans.filter((n) => n.status === 'active').length} active loans`),
      tile('LVR', totals.lvr === null ? '—' : `${totals.lvr}%`, totals.lvr === null ? null : h(`span.text-${lvrKind(totals.lvr) === 'ok' ? 'ok' : lvrKind(totals.lvr)}`, totals.lvr > 80 ? 'Above 80%' : 'At or below 80%')),
      tile('Usable equity', compactMoney(totals.usable_equity), 'to 80% LVR'),
      tile('Net position', compactMoney(totals.net_position), `assets ${compactMoney(totals.total_assets)}`)),
    structure.warnings.length ? h('div.alert.warn-box', h('strong', 'Worth a look'), h('ul', structure.warnings.map((w) => h('li', w)))) : null,
    lendingStructure(structure, contact),
    propertiesCard(contact, properties, methods),
    loansCard(contact, loans, properties),
    assetsCard(contact, assets));
}
