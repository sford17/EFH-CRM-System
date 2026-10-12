'use strict';
const db = require('./index');
const { STAGE_SMS, BIRTHDAY_SMS, SMS_AUTOMATIONS, TEMPLATE_SMS, RATE_REDUCTION_TEMPLATE } = require('./sms-defaults');
const { CALENDAR_AUTOMATIONS } = require('./calendar-defaults');

// Indicative commission rates; edit them on the Lenders page to match your
// aggregator's schedule.
const LENDERS = [
  ['ANZ', 0.65, 0.15, 24], ['Commonwealth Bank', 0.65, 0.15, 24], ['NAB', 0.65, 0.15, 24],
  ['Westpac', 0.65, 0.15, 24], ['Macquarie Bank', 0.65, 0.15, 24], ['ING', 0.6, 0.15, 24],
  ['St.George', 0.65, 0.15, 24], ['Suncorp', 0.65, 0.15, 24], ['Bankwest', 0.65, 0.15, 24],
  ['Bank of Queensland', 0.65, 0.15, 24], ['Pepper Money', 0.65, 0.15, 24], ['Liberty', 0.65, 0.15, 24],
];

// The sender's email signature is added after this when the email is sent.
const SIGNOFF = '\n\nKind regards,';

const TEMPLATES = [
  ['Welcome – new enquiry', 'onboarding', 'Thanks for getting in touch, {{contact.first_name}}',
    `Hi {{contact.first_name}},\n\nThanks for reaching out to {{business.name}}. I'll give you a call shortly to understand what you're looking to achieve.\n\nTo make our first chat as useful as possible, it helps to have a rough idea of your income, savings and any existing debts handy.${SIGNOFF}`],
  ['Lead follow-up', 'onboarding', 'Still keen to chat about your home loan, {{contact.first_name}}?',
    `Hi {{contact.first_name}},\n\nI tried to reach you about your home loan enquiry. When's a good time for a quick 15-minute call? Just reply with a time that suits.${SIGNOFF}`],
  ['Document request', 'application', 'Documents needed for your loan – {{deal.title}}',
    `Hi {{contact.first_name}},\n\nTo get your application moving, could you please send through the following:\n\n{{deal.outstanding_documents}}\n\nClear photos or PDFs are fine. Let me know if anything is unclear.${SIGNOFF}`],
  ['Pre-approval obtained', 'application', 'Great news – you are pre-approved!',
    `Hi {{contact.first_name}},\n\nGood news: {{deal.lender_name}} has pre-approved you for up to {{deal.loan_amount|money}}. The pre-approval is valid until {{deal.pre_approval_expiry|date}}.\n\nWhen you find a property you like, send me the contract before you sign so I can check it over with you.${SIGNOFF}`],
  ['Pre-approval expiring', 'application', 'Your pre-approval expires soon',
    `Hi {{contact.first_name}},\n\nJust a heads up that your pre-approval with {{deal.lender_name}} expires on {{deal.pre_approval_expiry|date}}. If you're still looking, let me know and I'll arrange an extension with updated documents.${SIGNOFF}`],
  ['Application lodged', 'application', 'Your loan application has been lodged',
    `Hi {{contact.first_name}},\n\nYour application with {{deal.lender_name}} for {{deal.loan_amount|money}} has been lodged. I'll keep an eye on it and let you know as soon as the lender comes back to us.${SIGNOFF}`],
  ['Conditional approval', 'application', 'Conditional approval received',
    `Hi {{contact.first_name}},\n\n{{deal.lender_name}} has conditionally approved your loan. We just need to satisfy a few remaining conditions (usually a valuation and a few final documents) before formal approval. I'll be in touch about anything we need from you.${SIGNOFF}`],
  ['Unconditional approval', 'application', 'Your loan is formally approved!',
    `Hi {{contact.first_name}},\n\nCongratulations – your loan with {{deal.lender_name}} is formally approved. The loan documents will arrive shortly; please sign and return them as soon as possible so we can book settlement.${SIGNOFF}`],
  ['Settlement reminder', 'settlement', 'Settlement is coming up on {{deal.settlement_date|date}}',
    `Hi {{contact.first_name}},\n\nSettlement for {{deal.property_address}} is booked for {{deal.settlement_date|date}}. Please make sure any funds to complete are in place and keep your phone handy on the day.${SIGNOFF}`],
  ['Settlement congratulations', 'settlement', 'Congratulations, {{contact.first_name}} – you have settled!',
    `Hi {{contact.first_name}},\n\nCongratulations – your loan has settled! It's been a pleasure helping you.\n\nYour first repayment will be scheduled by {{deal.lender_name}}. I'll check in over the coming months and review your loan each year to make sure it stays competitive.${SIGNOFF}`],
  ['Review request', 'marketing', 'How did we do, {{contact.first_name}}?',
    `Hi {{contact.first_name}},\n\nNow that you've settled in, I'd love to hear how you found the process. If you were happy, a quick Google review would mean a lot – and if you know anyone thinking about buying or refinancing, I'd be glad to help them too.${SIGNOFF}`],
  ['Fixed rate expiry review', 'retention', 'Your fixed rate ends on {{deal.fixed_expiry_date|date}}',
    `Hi {{contact.first_name}},\n\nYour fixed rate with {{deal.lender_name}} ends on {{deal.fixed_expiry_date|date}}. When it does, the loan will roll onto the lender's standard variable rate, which is often higher.\n\nLet's book a quick review so we can compare your options – re-fixing, going variable, or refinancing.${SIGNOFF}`],
  ['Annual loan review', 'retention', 'Time for your annual home loan health check',
    `Hi {{contact.first_name}},\n\nIt's been another year since your loan settled. Rates and lender offers change all the time, so I'd like to do a quick health check to make sure you're still on a sharp rate. Reply with a time that suits for a 15-minute call.${SIGNOFF}`],
  ['Birthday', 'marketing', 'Happy birthday, {{contact.first_name}}!',
    `Hi {{contact.first_name}},\n\nWishing you a very happy birthday from all of us at {{business.name}}. Have a great day!${SIGNOFF}`],
];

// Each automation references templates by name; ids are resolved at seed time.
const AUTOMATIONS = [
  {
    name: 'New lead: welcome email & first call', trigger: 'contact.created',
    description: 'Sends a welcome email and creates an urgent call task for the owner.',
    conditions: [{ field: 'contact.status', op: 'eq', value: 'lead' }],
    actions: [
      { type: 'send_email', template: 'Welcome – new enquiry' },
      { type: 'create_task', title: 'Call {{contact.full_name}} – new enquiry', due_in_days: 0, priority: 'high' },
      { type: 'notify', message: 'New lead: {{contact.full_name}}' },
    ],
  },
  {
    name: 'Deal created: build document checklist', trigger: 'deal.created',
    description: 'Adds the standard document checklist for the loan purpose.',
    actions: [{ type: 'create_document_checklist' }],
  },
  {
    name: 'Fact find: request documents', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'fact_find' }],
    actions: [
      { type: 'create_document_checklist' },
      { type: 'send_email', template: 'Document request' },
      { type: 'create_task', title: 'Review documents received from {{contact.first_name}}', due_in_days: 3 },
    ],
  },
  {
    name: 'Pre-approval: notify client', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'pre_approval' }],
    actions: [
      { type: 'send_email', template: 'Pre-approval obtained' },
      { type: 'create_task', title: 'Check in with {{contact.first_name}} on property search', due_in_days: 14 },
    ],
  },
  {
    name: 'Application lodged: notify client', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'application_lodged' }],
    actions: [
      { type: 'send_email', template: 'Application lodged' },
      { type: 'create_task', title: 'Chase {{deal.lender_name}} for assessment update', due_in_days: 3 },
    ],
  },
  {
    name: 'Conditional approval: satisfy conditions', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'conditional_approval' }],
    actions: [
      { type: 'send_email', template: 'Conditional approval' },
      { type: 'create_task', title: 'Satisfy approval conditions (valuation, outstanding docs)', due_in_days: 2, priority: 'high' },
    ],
  },
  {
    name: 'Unconditional approval: loan docs & settlement', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'unconditional_approval' }],
    actions: [
      { type: 'send_email', template: 'Unconditional approval' },
      { type: 'create_task', title: 'Issue loan docs and confirm settlement with solicitor/conveyancer', due_in_days: 1, priority: 'high' },
    ],
  },
  {
    name: 'Settled: congratulate, convert to client & book commissions', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'settled' }],
    actions: [
      { type: 'send_email', template: 'Settlement congratulations' },
      { type: 'set_contact_status', status: 'client' },
      { type: 'add_tag', tag: 'settled' },
      { type: 'generate_commissions' },
      { type: 'create_task', title: 'Post-settlement check-in call with {{contact.first_name}}', due_in_days: 30 },
      { type: 'send_email', template: 'Review request', delay_days: 14 },
    ],
  },
  {
    name: 'Deal lost: move to nurture', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'lost' }],
    actions: [
      { type: 'add_tag', tag: 'nurture' },
      { type: 'create_task', title: 'Re-engage {{contact.first_name}} (lost: {{deal.lost_reason}})', due_in_days: 90, priority: 'low' },
    ],
  },
  {
    name: 'Fixed rate expiring in 90 days', trigger: 'schedule.fixed_rate_expiry', trigger_config: { days_before: 90 },
    description: 'Retention: contact clients before their fixed rate rolls to the revert rate.',
    actions: [
      { type: 'send_email', template: 'Fixed rate expiry review' },
      { type: 'create_task', title: 'Fixed rate review: {{contact.full_name}} ({{deal.lender_name}}, expires {{deal.fixed_expiry_date|date}})', due_in_days: 0, priority: 'high' },
    ],
  },
  {
    name: 'Pre-approval expiring in 14 days', trigger: 'schedule.pre_approval_expiry', trigger_config: { days_before: 14 },
    actions: [
      { type: 'send_email', template: 'Pre-approval expiring' },
      { type: 'create_task', title: 'Pre-approval expiring for {{contact.full_name}} – extend?', due_in_days: 0 },
    ],
  },
  {
    name: 'Finance due date in 3 days', trigger: 'schedule.finance_due', trigger_config: { days_before: 3 },
    description: 'Warns when a subject-to-finance date is close and the loan is not yet unconditional.',
    actions: [
      { type: 'create_task', title: 'URGENT: finance due {{deal.finance_due_date|date}} – {{deal.title}}', due_in_days: 0, priority: 'high' },
      { type: 'notify', message: 'Finance due {{deal.finance_due_date|date}} for {{deal.title}}' },
    ],
  },
  {
    name: 'Settlement in 2 days', trigger: 'schedule.settlement_upcoming', trigger_config: { days_before: 2 },
    actions: [
      { type: 'send_email', template: 'Settlement reminder' },
      { type: 'create_task', title: 'Confirm settlement figures & funds to complete – {{deal.title}}', due_in_days: 0, priority: 'high' },
    ],
  },
  {
    name: 'Settlement anniversary: annual review', trigger: 'schedule.settlement_anniversary',
    actions: [
      { type: 'send_email', template: 'Annual loan review' },
      { type: 'create_task', title: 'Annual loan review: {{contact.full_name}}', due_in_days: 7 },
    ],
  },
  {
    name: 'Client birthday', trigger: 'schedule.birthday',
    conditions: [{ field: 'contact.status', op: 'in', value: 'client,past_client,prospect' }],
    actions: [{ type: 'send_email', template: 'Birthday' }],
  },
  {
    name: 'Review date reached', trigger: 'schedule.review_due',
    actions: [{ type: 'create_task', title: 'Scheduled review due: {{contact.full_name}}', due_in_days: 0 }],
  },
  {
    name: 'Stale deal: no activity for 10 days', trigger: 'schedule.stale_deal', trigger_config: { days_inactive: 10 },
    actions: [{ type: 'create_task', title: 'Follow up – {{deal.title}} has been in {{deal.stage_label}} with no activity', due_in_days: 0 }],
  },
  {
    name: 'Uncontacted lead after 2 days', trigger: 'schedule.stale_lead', trigger_config: { days_inactive: 2 },
    actions: [
      { type: 'send_email', template: 'Lead follow-up' },
      { type: 'create_task', title: 'Second attempt: call {{contact.full_name}}', due_in_days: 0, priority: 'high' },
    ],
  },
];

TEMPLATES.push(RATE_REDUCTION_TEMPLATE);
for (const a of AUTOMATIONS) {
  if (STAGE_SMS[a.name]) a.actions.push({ type: 'send_sms', message: STAGE_SMS[a.name] });
  if (a.name === BIRTHDAY_SMS.automation) a.actions.push({ type: 'send_sms', message: BIRTHDAY_SMS.message, marketing: true });
}
AUTOMATIONS.push(...SMS_AUTOMATIONS, ...CALENDAR_AUTOMATIONS);

function seedDefaults() {
  db.transaction(() => {
    if (!db.one('SELECT 1 FROM lenders LIMIT 1')) {
      for (const [name, upfront, trail, clawback] of LENDERS) {
        db.insert('lenders', { name, upfront_pct: upfront, trail_pct: trail, clawback_months: clawback });
      }
    }
    if (!db.one('SELECT 1 FROM email_templates LIMIT 1')) {
      for (const [name, category, subject, body] of TEMPLATES) {
        db.insert('email_templates', { name, category, subject, body, sms_body: TEMPLATE_SMS[name] || null });
      }
    }
    if (!db.getSetting('automations_seeded')) {
      const templateId = (name) => db.one('SELECT id FROM email_templates WHERE name = ?', name)?.id;
      for (const a of AUTOMATIONS) {
        const actions = a.actions
          .map(({ template, ...rest }) => (template ? { ...rest, template_id: templateId(template) } : rest))
          .filter((x) => x.type !== 'send_email' || x.template_id);
        db.insert('automations', {
          name: a.name,
          description: a.description || null,
          trigger: a.trigger,
          trigger_config: JSON.stringify(a.trigger_config || {}),
          conditions: JSON.stringify(a.conditions || []),
          actions: JSON.stringify(actions),
        });
      }
      db.setSetting('automations_seeded', '1');
    }
    if (!db.getSetting('business_name')) db.setSetting('business_name', 'EFH Mortgage Broking');
  });
}

module.exports = { seedDefaults, LENDERS, TEMPLATES, AUTOMATIONS };

if (require.main === module) {
  db.open();
  seedDefaults();
  require('./demo').seedDemo();
  console.log('Seeded defaults and demo data. Sign in as admin@efh.local / changeme123');
}
