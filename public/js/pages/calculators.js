import { api, h, pageHeader, field, readForm, money, money2, attempt, table } from '../core.js';

const CALCS = [
  {
    key: 'repayment', title: 'Repayments',
    fields: [
      { name: 'loan_amount', label: 'Loan amount ($)', type: 'number', default: 600000, required: true },
      { name: 'interest_rate', label: 'Interest rate (%)', type: 'number', step: 0.01, default: 6.0, required: true },
      { name: 'loan_term_years', label: 'Term (years)', type: 'number', default: 30, required: true },
      { name: 'frequency', label: 'Frequency', type: 'select', required: true, options: [['monthly', 'Monthly'], ['fortnightly', 'Fortnightly'], ['weekly', 'Weekly']] },
      { name: 'repayment_type', label: 'Type', type: 'select', required: true, options: [['pi', 'Principal & interest'], ['io', 'Interest only first']] },
      { name: 'io_years', label: 'Interest-only years', type: 'number', default: 5 },
    ],
    render: (r) => [
      ['Repayment (P&I)', money2(r.payment) + ` / ${r.frequency.replace('ly', '')}`],
      r.interest_only_payment ? [`Interest-only for ${r.interest_only_years} yrs`, money2(r.interest_only_payment)] : null,
      ['Total interest', money(r.total_interest)],
      ['Total repaid', money(r.total_repaid)],
    ],
  },
  {
    key: 'borrowing-power', title: 'Borrowing power (estimate)',
    fields: [
      { name: 'applicant1_income', label: 'Applicant 1 gross income ($ p.a.)', type: 'number', default: 110000, required: true },
      { name: 'applicant2_income', label: 'Applicant 2 gross income ($ p.a.)', type: 'number' },
      { name: 'rental_income', label: 'Rental income ($ p.a.)', type: 'number' },
      { name: 'other_income', label: 'Other net income ($ p.a.)', type: 'number' },
      { name: 'dependants', label: 'Dependants', type: 'number', default: 0 },
      { name: 'living_expenses', label: 'Declared living expenses ($ / month)', type: 'number' },
      { name: 'existing_repayments', label: 'Other loan repayments ($ / month)', type: 'number' },
      { name: 'credit_card_limits', label: 'Total credit card limits ($)', type: 'number' },
      { name: 'interest_rate', label: 'Product rate (%)', type: 'number', step: 0.01, default: 6.2 },
      { name: 'buffer', label: 'Serviceability buffer (%)', type: 'number', step: 0.1, default: 3 },
    ],
    render: (r) => [
      ['Estimated maximum loan', money(r.max_loan)],
      ['Repayment at product rate', `${money2(r.repayment_at_actual_rate)} / month`],
      ['Net monthly income', money2(r.net_monthly_income)],
      ['Living expenses used', `${money2(r.living_expenses_used)} (benchmark ${money(r.benchmark_expenses)})`],
      ['Other commitments', money2(r.monthly_commitments)],
      ['Assessment rate', `${r.assessment_rate}%`],
    ],
    note: 'Simplified serviceability: 2024-25 tax rates, 80% of rental income, 3.8% of card limits, expenses floored at a benchmark. Lender calculators will differ.',
  },
  {
    key: 'lvr', title: 'LVR & LMI (indicative)',
    fields: [
      { name: 'property_value', label: 'Property value ($)', type: 'number', default: 800000, required: true },
      { name: 'loan_amount', label: 'Loan amount ($)', type: 'number', default: 720000, required: true },
    ],
    render: (r) => [
      ['LVR', `${r.lvr}%`],
      ['Deposit / equity', money(r.deposit)],
      ['LMI required', r.lmi_required ? 'Yes' : 'No'],
      ['Indicative LMI premium', r.lmi_estimate === null ? '—' : money(r.lmi_estimate)],
      ['Max loan without LMI (80%)', money(r.loan_to_avoid_lmi)],
      r.note ? ['Note', r.note] : null,
    ],
    note: 'LMI figures are rough bands only – get a quote from the lender or insurer.',
  },
  {
    key: 'refinance', title: 'Refinance savings',
    fields: [
      { name: 'loan_balance', label: 'Loan balance ($)', type: 'number', default: 500000, required: true },
      { name: 'remaining_years', label: 'Remaining term (years)', type: 'number', default: 25, required: true },
      { name: 'current_rate', label: 'Current rate (%)', type: 'number', step: 0.01, default: 6.6, required: true },
      { name: 'new_rate', label: 'New rate (%)', type: 'number', step: 0.01, default: 5.89, required: true },
      { name: 'switching_costs', label: 'Switching costs ($)', type: 'number', default: 800 },
      { name: 'cashback', label: 'Cashback ($)', type: 'number', default: 0 },
    ],
    render: (r) => [
      ['Monthly saving', money2(r.monthly_saving)],
      ['Annual saving', money(r.annual_saving)],
      ['Saving over remaining term', money(r.lifetime_saving)],
      ['Current repayment', money2(r.current_payment)],
      ['New repayment', money2(r.new_payment)],
      ['Break-even', r.breakeven_months === null ? 'Never' : `${r.breakeven_months} months`],
    ],
  },
];

// ---- Stamp duty -----------------------------------------------------------------
const STATE_OPTIONS = [['NSW', 'New South Wales'], ['VIC', 'Victoria'], ['QLD', 'Queensland'], ['WA', 'Western Australia'], ['SA', 'South Australia'], ['TAS', 'Tasmania'], ['ACT', 'Australian Capital Territory'], ['NT', 'Northern Territory']];

function dutyResult(r) {
  const rows = [
    [`Stamp duty – ${r.state_name}`, money2(r.total)],
    r.kind === 'residential' ? ['Property', `${r.property_type} · ${r.buyer} · ${money(r.property_value)}`] : ['Property value', money(r.property_value)],
    r.kind === 'residential' && r.concessions.length ? ['Duty at general rates', money2(r.general_duty)] : null,
    ...(r.concessions || []).map((c) => [c.label, `− ${money2(c.saving)}`]),
    r.kind === 'residential' && (r.concessions.length || r.foreign_surcharge) ? ['Transfer duty', money2(r.transfer_duty)] : null,
    r.foreign_surcharge ? [`Foreign purchaser surcharge (${r.foreign_rate}%)`, money2(r.foreign_surcharge)] : null,
    ['Effective rate', `${r.effective_rate}% of the price`],
  ].filter(Boolean);
  const best = Math.min(...r.comparison.map((c) => c.total));
  return [
    h('dl.calc-result', rows.map(([k, v], i) => h(`div.info-row${i === 0 ? '.headline' : ''}`, h('dt', k), h('dd', v)))),
    r.verify.length ? h('div.alert.warn-box.small', h('strong', 'Please confirm: '), `${r.verify.join('; ')} could not be checked against the official calculator when these rates were loaded. `,
      h('a', { href: r.calculator, target: '_blank', rel: 'noopener noreferrer' }, 'Check on the official calculator ↗')) : null,
    r.notes.length ? h('ul.duty-notes.small', r.notes.map((n) => h('li', n))) : null,
    h('details.duty-compare',
      h('summary.small', 'The same purchase in other states'),
      table([
        { label: 'State', value: (c) => (c.state === r.state ? h('strong', c.state) : c.state) },
        { label: 'Stamp duty', value: (c) => h('span', money2(c.total), c.total === best ? h('span.muted.small', ' lowest') : null), class: 'num' },
      ], r.comparison)),
    h('p.muted.small', `${r.rates_label}. An estimate only, excluding land titles office registration fees. `,
      h('a', { href: r.calculator, target: '_blank', rel: 'noopener noreferrer' }, `${r.state_name} official calculator ↗`)),
  ];
}

const STAMP_DUTY = [
  {
    key: 'stamp-duty-residential', title: 'Stamp duty – residential',
    fields: [
      { name: 'state', label: 'State or territory', type: 'select', required: true, options: STATE_OPTIONS, default: 'NSW' },
      { name: 'property_value', label: 'Purchase price ($)', type: 'number', default: 850000, required: true },
      { name: 'property_type', label: 'Property', type: 'select', required: true, options: [['established', 'Established home'], ['new', 'New home'], ['off_the_plan', 'Off-the-plan apartment / unit'], ['land', 'Vacant land to build on']] },
      { name: 'buyer', label: 'Buying to', type: 'select', required: true, options: [['owner', 'Live in (owner-occupier)'], ['investor', 'Invest']] },
      { name: 'first_home', label: 'First home buyer', type: 'checkbox', default: false },
      { name: 'foreign', label: 'Foreign purchaser', type: 'checkbox', default: false },
    ],
    result: dutyResult,
    note: 'Includes owner-occupier rates and first home buyer exemptions and concessions where eligible, plus foreign purchaser surcharges.',
  },
  {
    key: 'stamp-duty-commercial', title: 'Stamp duty – commercial',
    fields: [
      { name: 'state', label: 'State or territory', type: 'select', required: true, options: STATE_OPTIONS, default: 'NSW' },
      { name: 'property_value', label: 'Purchase price ($, excluding GST)', type: 'number', default: 1500000, required: true },
    ],
    result: dutyResult,
    note: 'Commercial, industrial and other non-residential property.',
  },
];

function calcCard(c) {
  const out = h(c.result ? 'div.calc-output' : 'dl.calc-result', h('p.muted', 'Enter the numbers and press Calculate.'));
  const form = h('form.grid-form', c.fields.map((f) => field(f)), h('div.actions.full', h('button', { type: 'submit' }, 'Calculate')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api(`/calculators/${c.key}`, { method: 'POST', body: readForm(form, c.fields) }));
    if (c.result) out.replaceChildren(...c.result(r).filter(Boolean));
    else out.replaceChildren(...c.render(r).filter(Boolean).map(([k, v], i) => h(`div.info-row${i === 0 ? '.headline' : ''}`, h('dt', k), h('dd', v))));
  });
  return h('section.card', h('h2', c.title), form, out, c.note ? h('p.muted.small', c.note) : null);
}

export async function calculatorsPage() {
  return h('div', pageHeader('Calculators'),
    h('h2.section-title', 'Stamp duty'),
    h('div.grid-2', STAMP_DUTY.map(calcCard)),
    h('h2.section-title', 'Loans'),
    h('div.grid-2', CALCS.map(calcCard)));
}
