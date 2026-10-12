'use strict';
// Texting referral partners when a client they referred settles.

// Plain characters only (no curly quotes or long dashes) so it fits in one
// standard 160-character SMS for typical names.
const REFERRAL_SETTLED_SMS = 'Hi {{referrer.first_name}}, great news - {{contact.full_name}}\'s loan has settled. Thanks so much for the referral! {{broker.first_name}}, {{business.name}}';

const REFERRAL_AUTOMATIONS = [
  {
    name: 'Settled: thank the referral partner',
    description: 'Texts the referral partner who referred the client when the loan settles. Partners can be switched off on the Partners & agents page.',
    trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'settled' }],
    actions: [{ type: 'send_sms', to: 'referral_partner', message: REFERRAL_SETTLED_SMS }],
  },
];

module.exports = { REFERRAL_AUTOMATIONS, REFERRAL_SETTLED_SMS };
