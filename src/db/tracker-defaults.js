'use strict';
// Mortgage tracker defaults shared by seeding and the upgrade migration.

const IO_EXPIRY_AUTOMATION = {
  name: 'Interest-only period ending in 90 days', trigger: 'schedule.io_expiry', trigger_config: { days_before: 90 },
  description: 'Repayments jump when an interest-only period ends – review the loan with the client first.',
  actions: [
    { type: 'create_task', title: 'Interest-only ending: {{contact.full_name}} ({{loan.lender_name}}, {{loan.io_expiry_date|date}}) – review repayments', due_in_days: 0, priority: 'high' },
  ],
};

// Text replaced in default templates/automations that nobody has edited:
// fixed-rate details now come from the tracker loan rather than the deal.
const FIXED_RATE_TEXT_UPDATES = [
  ['{{deal.fixed_expiry_date|date}}', '{{loan.fixed_expiry_date|date}}'],
  ['Your fixed rate with {{deal.lender_name}}', 'Your fixed rate with {{loan.lender_name}}'],
  ['({{deal.lender_name}}, expires', '({{loan.lender_name}}, expires'],
];

module.exports = { IO_EXPIRY_AUTOMATION, FIXED_RATE_TEXT_UPDATES };
