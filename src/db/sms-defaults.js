'use strict';
// Default SMS wording, shared by first-time seeding and the migration that adds
// SMS to existing installs. Plain ASCII keeps each text to cheaper GSM-7 SMS
// segments (160 characters each).

const SIGN = ' - {{broker.first_name}}, {{business.name}}';

// SMS added to the default stage automations, keyed by automation name.
const STAGE_SMS = {
  'Fact find: request documents': `Hi {{contact.first_name}}, I've emailed you a list of the documents we need for your loan. Any questions, just reply or give me a call.${SIGN}`,
  'Pre-approval: notify client': `Great news {{contact.first_name}}! You're pre-approved with {{deal.lender_name}}. All the details are in your email.${SIGN}`,
  'Application lodged: notify client': `Hi {{contact.first_name}}, your loan application has been lodged with {{deal.lender_name}}. I'll update you as soon as we hear back.${SIGN}`,
  'Conditional approval: satisfy conditions': `Hi {{contact.first_name}}, {{deal.lender_name}} has conditionally approved your loan. We're now working through the final conditions.${SIGN}`,
  'Unconditional approval: loan docs & settlement': `Congratulations {{contact.first_name}}! Your loan is formally approved. Your loan documents are on the way - please sign and return them ASAP.${SIGN}`,
  'Settled: congratulate, convert to client & book commissions': `Congratulations {{contact.first_name}}, your loan has settled! It's been a pleasure helping you.${SIGN}`,
};

const BIRTHDAY_SMS = {
  automation: 'Client birthday',
  message: 'Happy birthday {{contact.first_name}}! Wishing you a great day from all of us at {{business.name}}. - {{broker.first_name}}',
};

// Automations that exist only to send an SMS.
const SMS_AUTOMATIONS = [
  {
    name: 'New deal: welcome SMS', trigger: 'deal.created',
    description: 'Texts the borrower when a new deal is opened at the New Lead stage.',
    conditions: [{ field: 'deal.stage', op: 'eq', value: 'lead' }],
    actions: [{ type: 'send_sms', message: `Hi {{contact.first_name}}, thanks for choosing {{business.name}} for your home loan. I'll be in touch shortly.${SIGN}` }],
  },
  {
    name: 'Settlement booked: SMS', trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'settlement_booked' }],
    actions: [{ type: 'send_sms', message: `Hi {{contact.first_name}}, your settlement is booked for {{deal.settlement_date|date}}. I'll be in touch on the day.${SIGN}` }],
  },
];

// Texts sent alongside these email templates whenever they are sent.
const TEMPLATE_SMS = {
  'Annual loan review': `Hi {{contact.first_name}}, it's time for your annual home loan review. I've sent you an email - when suits for a quick chat?${SIGN}`,
  'Rate reduction': `Hi {{contact.first_name}}, good news - rates have dropped. I've emailed you about lowering the rate on your home loan. When suits for a quick chat?${SIGN}`,
};

const RATE_REDUCTION_TEMPLATE = [
  'Rate reduction', 'retention', 'Good news: rates have come down',
  `Hi {{contact.first_name}},\n\nInterest rates have come down, and I want to make sure you get the full benefit on your home loan.\n\nLenders don't always pass on reductions in full, and new customers are often offered sharper rates than existing ones. I can check your current rate, ask your lender for a better deal, and compare it against other lenders - at no cost to you.\n\nReply to this email or give me a call and we'll get it sorted.\n\nKind regards,`,
];

module.exports = { STAGE_SMS, BIRTHDAY_SMS, SMS_AUTOMATIONS, TEMPLATE_SMS, RATE_REDUCTION_TEMPLATE };
