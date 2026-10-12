'use strict';
// Emails to the other professionals on a deal. {{recipient.*}} is the agent,
// solicitor or buyer's agent the email is going to.

const PARTY_TEMPLATES = [
  ['Finance approved – note to agent', 'deal', 'Finance approved – {{deal.property_address}}',
    `Hi {{recipient.first_name}},

I'm pleased to confirm that finance for {{contact.full_name}}'s purchase of {{deal.property_address}} has been formally approved by {{deal.lender_name}}.

The lender will now prepare the loan documents and we'll work with the solicitor/conveyancer towards settlement. Please let me know if you need anything further from our end.

Kind regards,
{{broker.name}}
{{broker.phone}}`],
  ['Settlement booked – note to solicitor', 'deal', 'Settlement booked – {{contact.full_name}}, {{deal.property_address}}',
    `Hi {{recipient.first_name}},

Just confirming that settlement for {{contact.full_name}} is booked with {{deal.lender_name}} for {{deal.settlement_date|date}}.

Property: {{deal.property_address}}
Loan amount: {{deal.loan_amount|money}}
Lender reference: {{deal.application_ref}}

If you need anything from the lender or from me before settlement, just let me know.

Kind regards,
{{broker.name}}
{{broker.phone}}`],
  ['Introduction – agent & solicitor', 'deal', 'Introduction – {{contact.full_name}}',
    `Hi {{recipient.first_name}},

I'm {{contact.first_name}}'s mortgage broker for their purchase of {{deal.property_address}}. I'll be looking after the finance side of things, so please feel free to contact me directly with any finance questions or dates.

Kind regards,
{{broker.name}}
{{broker.phone}} · {{broker.email}}`],
];

const CONSENT_NOTE = 'Off by default: only switch on if your clients are happy for you to share finance updates.';

const PARTY_AUTOMATIONS = [
  {
    name: 'Unconditional approval: tell the agents',
    description: `Emails the real estate agent and buyer's agent on the deal that finance is approved. ${CONSENT_NOTE}`,
    trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'unconditional_approval' }],
    actions: [
      { type: 'send_email', template: 'Finance approved – note to agent', to: 'real_estate_agent' },
      { type: 'send_email', template: 'Finance approved – note to agent', to: 'buyers_agent' },
    ],
  },
  {
    name: 'Settlement booked: confirm with the solicitor',
    description: `Emails the client's solicitor/conveyancer the settlement date, lender and loan amount. ${CONSENT_NOTE}`,
    trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'settlement_booked' }],
    actions: [{ type: 'send_email', template: 'Settlement booked – note to solicitor', to: 'solicitor' }],
  },
];

module.exports = { PARTY_TEMPLATES, PARTY_AUTOMATIONS };
