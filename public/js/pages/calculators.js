import { api, h, pageHeader, field, readForm, money, money2, attempt } from '../core.js';

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

function calcCard(c) {
  const out = h('dl.calc-result', h('p.muted', 'Enter the numbers and press Calculate.'));
  const form = h('form.grid-form', c.fields.map((f) => field(f)), h('div.actions.full', h('button', { type: 'submit' }, 'Calculate')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api(`/calculators/${c.key}`, { method: 'POST', body: readForm(form, c.fields) }));
    out.replaceChildren(...c.render(r).filter(Boolean).map(([k, v], i) => h(`div.info-row${i === 0 ? '.headline' : ''}`, h('dt', k), h('dd', v))));
  });
  return h('section.card', h('h2', c.title), form, out, c.note ? h('p.muted.small', c.note) : null);
}

export async function calculatorsPage() {
  return h('div', pageHeader('Calculators'), h('div.grid-2', CALCS.map(calcCard)));
}
