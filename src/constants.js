'use strict';

// Deal pipeline, in order. `settled` and `lost` are terminal.
const STAGES = [
  { key: 'lead', label: 'New Lead' },
  { key: 'fact_find', label: 'Fact Find' },
  { key: 'pre_approval', label: 'Pre-Approval' },
  { key: 'application_lodged', label: 'Application Lodged' },
  { key: 'conditional_approval', label: 'Conditional Approval' },
  { key: 'unconditional_approval', label: 'Unconditional Approval' },
  { key: 'settlement_booked', label: 'Settlement Booked' },
  { key: 'settled', label: 'Settled' },
  { key: 'lost', label: 'Lost' },
];
const STAGE_KEYS = STAGES.map((s) => s.key);
const OPEN_STAGES = STAGE_KEYS.filter((s) => s !== 'settled' && s !== 'lost');

// Standard document checklist, by loan purpose. `*` applies to every deal.
const DOCUMENT_CHECKLIST = {
  '*': [
    ['Photo ID (driver licence / passport)', 'identity'],
    ['Medicare card', 'identity'],
    ['Last 2 payslips', 'income'],
    ['3 months transaction statements', 'banking'],
    ['3 months savings statements', 'banking'],
    ['Credit card & personal loan statements', 'liabilities'],
    ['Signed privacy consent & credit guide', 'compliance'],
  ],
  self_employed: [
    ['2 years personal tax returns & NOAs', 'income'],
    ['2 years company financials', 'income'],
    ['ATO portal statement', 'income'],
  ],
  purchase: [['Signed contract of sale', 'property'], ['Deposit evidence', 'banking']],
  first_home: [
    ['Signed contract of sale', 'property'],
    ['Genuine savings evidence (3 months)', 'banking'],
    ['First Home Owner Grant application', 'compliance'],
  ],
  refinance: [['Current loan statements (6 months)', 'liabilities'], ['Rates notice', 'property']],
  investment: [
    ['Signed contract of sale', 'property'],
    ['Rental appraisal / lease agreement', 'income'],
  ],
  construction: [
    ['Fixed price building contract', 'property'],
    ['Council approved plans & specs', 'property'],
    ["Builder's insurance", 'property'],
  ],
  top_up: [['Current loan statements (6 months)', 'liabilities'], ['Purpose of funds statement', 'compliance']],
};

const EVENT_TRIGGERS = [
  { key: 'contact.created', label: 'Contact created' },
  { key: 'contact.status_changed', label: 'Contact status changed' },
  { key: 'deal.created', label: 'Deal created' },
  { key: 'deal.stage_changed', label: 'Deal stage changed' },
  { key: 'task.completed', label: 'Task completed' },
  { key: 'email.received', label: 'Email received from a contact' },
  { key: 'appointment.booked', label: 'Appointment booked (Calendly)' },
  { key: 'appointment.cancelled', label: 'Appointment cancelled (Calendly)' },
  { key: 'document.signed', label: 'Document signed (Adobe Sign)' },
  { key: 'fact_find.submitted', label: 'Client completed their online fact find or documents' },
];
const SCHEDULED_TRIGGERS = [
  { key: 'schedule.fixed_rate_expiry', label: 'Fixed rate expiring (days_before)' },
  { key: 'schedule.io_expiry', label: 'Interest-only period ending (days_before)' },
  { key: 'schedule.pre_approval_expiry', label: 'Pre-approval expiring (days_before)' },
  { key: 'schedule.finance_due', label: 'Finance due date approaching (days_before)' },
  { key: 'schedule.settlement_upcoming', label: 'Settlement approaching (days_before)' },
  { key: 'schedule.settlement_anniversary', label: 'Settlement anniversary' },
  { key: 'schedule.birthday', label: 'Contact birthday' },
  { key: 'schedule.review_due', label: 'Contact review date reached' },
  { key: 'schedule.annual_review', label: 'Annual review coming up (days_before)' },
  { key: 'schedule.stale_deal', label: 'Open deal inactive (days_inactive)' },
  { key: 'schedule.stale_lead', label: 'Lead not contacted (days_inactive)' },
  { key: 'schedule.appointment_upcoming', label: 'Appointment coming up (days_before)' },
];
const ACTION_TYPES = [
  'create_task', 'send_email', 'send_sms', 'add_note', 'add_tag', 'remove_tag',
  'set_contact_status', 'set_deal_stage', 'notify', 'email_broker', 'create_document_checklist', 'generate_commissions',
  'send_fact_find',
];

module.exports = {
  STAGES, STAGE_KEYS, OPEN_STAGES, DOCUMENT_CHECKLIST,
  EVENT_TRIGGERS, SCHEDULED_TRIGGERS, ACTION_TYPES,
};
