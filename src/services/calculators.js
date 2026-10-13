'use strict';
// Broker calculators. All results are estimates for conversation purposes, not
// a lender's credit assessment.

const PERIODS = { monthly: 12, fortnightly: 26, weekly: 52 };
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
const n = (v, d = 0) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

function paymentFor(principal, annualRatePct, years, perYear = 12) {
  const r = annualRatePct / 100 / perYear;
  const count = years * perYear;
  if (r === 0) return principal / count;
  return (principal * r) / (1 - (1 + r) ** -count);
}

function repayment(input) {
  const principal = n(input.loan_amount);
  const rate = n(input.interest_rate);
  const years = n(input.loan_term_years, 30);
  const frequency = PERIODS[input.frequency] ? input.frequency : 'monthly';
  const perYear = PERIODS[frequency];
  const ioYears = input.repayment_type === 'io' ? Math.min(n(input.io_years, 5), years) : 0;
  if (principal <= 0 || years <= 0) throw new Error('Loan amount and term must be greater than zero');

  const ioPayment = ioYears ? (principal * rate) / 100 / perYear : 0;
  const piPayment = paymentFor(principal, rate, years - ioYears, perYear);
  const totalPaid = ioPayment * ioYears * perYear + piPayment * (years - ioYears) * perYear;
  return {
    frequency,
    interest_only_payment: ioYears ? round(ioPayment) : null,
    interest_only_years: ioYears,
    payment: round(piPayment),
    total_repaid: round(totalPaid),
    total_interest: round(totalPaid - principal),
  };
}

// Australian resident income tax (2024-25 rates) plus 2% Medicare levy.
function incomeTax(income) {
  const brackets = [
    [190000, 0.45, 51638],
    [135000, 0.37, 31288],
    [45000, 0.30, 4288],
    [18200, 0.16, 0],
  ];
  let tax = 0;
  for (const [threshold, rate, base] of brackets) {
    if (income > threshold) {
      tax = base + (income - threshold) * rate;
      break;
    }
  }
  const medicare = income > 26000 ? income * 0.02 : 0;
  return tax + medicare;
}

function borrowingPower(input) {
  const incomes = [n(input.applicant1_income), n(input.applicant2_income)].filter((x) => x > 0);
  if (!incomes.length) throw new Error('Enter at least one applicant income');
  const rental = n(input.rental_income) * 0.8; // lenders typically shade rental income to 80%
  const other = n(input.other_income);
  const netAnnual = incomes.reduce((sum, inc) => sum + inc - incomeTax(inc), 0) + rental + other;
  const netMonthly = netAnnual / 12;

  const couple = incomes.length > 1 || input.relationship === 'couple';
  const dependants = n(input.dependants);
  // Rough living-expense floor, standing in for the HEM benchmark lenders use.
  const benchmark = (couple ? 3200 : 2100) + dependants * 550;
  const declared = n(input.living_expenses);
  const expenses = Math.max(declared, benchmark);
  const commitments = n(input.existing_repayments) + n(input.credit_card_limits) * 0.038;

  const surplus = netMonthly - expenses - commitments;
  const buffer = n(input.buffer, 3);
  const assessmentRate = n(input.interest_rate, 6.5) + buffer;
  const years = n(input.loan_term_years, 30);
  const r = assessmentRate / 100 / 12;
  const maxLoan = surplus > 0 ? (surplus * (1 - (1 + r) ** -(years * 12))) / r : 0;
  const rounded = Math.max(0, Math.floor(maxLoan / 1000) * 1000);
  return {
    net_monthly_income: round(netMonthly),
    living_expenses_used: round(expenses),
    benchmark_expenses: round(benchmark),
    monthly_commitments: round(commitments),
    monthly_surplus: round(surplus),
    assessment_rate: round(assessmentRate),
    max_loan: rounded,
    repayment_at_actual_rate: rounded ? round(paymentFor(rounded, n(input.interest_rate, 6.5), years)) : 0,
  };
}

const { LMI_BANDS } = require('./purchaseCalc');

function lvr(input) {
  const value = n(input.property_value);
  let loan = n(input.loan_amount);
  if (!loan && input.deposit !== undefined) loan = value - n(input.deposit);
  if (value <= 0 || loan <= 0) throw new Error('Property value and loan amount must be greater than zero');
  const ratio = (loan / value) * 100;
  const band = LMI_BANDS.find(([max]) => ratio <= max);
  const lmiPct = band ? band[1] : null;
  return {
    loan_amount: round(loan),
    deposit: round(value - loan),
    lvr: round(ratio),
    lmi_required: ratio > 80,
    lmi_estimate: lmiPct === null ? null : round((loan * lmiPct) / 100, 0),
    note: lmiPct === null ? 'LVR above 95% — most lenders will not lend without a guarantor' : null,
    loan_to_avoid_lmi: round(value * 0.8, 0),
  };
}

function refinance(input) {
  const balance = n(input.loan_balance);
  const years = n(input.remaining_years, 25);
  const current = paymentFor(balance, n(input.current_rate), years);
  const proposed = paymentFor(balance, n(input.new_rate), years);
  const costs = n(input.switching_costs) - n(input.cashback);
  const monthlySaving = current - proposed;
  return {
    current_payment: round(current),
    new_payment: round(proposed),
    monthly_saving: round(monthlySaving),
    annual_saving: round(monthlySaving * 12),
    lifetime_saving: round(monthlySaving * years * 12 - costs),
    net_switching_costs: round(costs),
    breakeven_months: monthlySaving > 0 ? Math.max(0, Math.ceil(costs / monthlySaving)) : null,
  };
}

const stampDuty = require('./stampDuty');

const CALCULATORS = {
  repayment, 'borrowing-power': borrowingPower, lvr, refinance,
  'stamp-duty-residential': (input) => stampDuty.residential(input),
  'stamp-duty-commercial': (input) => stampDuty.commercial(input),
  purchase: (input) => require('./purchaseCalc').calculate(input),
};

module.exports = { CALCULATORS, incomeTax, paymentFor };
