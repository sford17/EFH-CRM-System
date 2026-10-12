'use strict';
// Asking clients for a Google review: the "Review request" template (email +
// SMS) and the automation that sends it after settlement.

// The wording shipped before Google review links were added, so unedited
// copies can be upgraded.
const OLD_REVIEW_BODY = 'Hi {{contact.first_name}},\n\nNow that you\'ve settled in, I\'d love to hear how you found the process. If you were happy, a quick Google review would mean a lot – and if you know anyone thinking about buying or refinancing, I\'d be glad to help them too.\n\nKind regards,';

const REVIEW_SUBJECT = 'How did we do, {{contact.first_name}}?';
const REVIEW_BODY = `Hi {{contact.first_name}},

Thank you again for trusting {{business.name}} with your home loan. It's been a pleasure helping you.

If you were happy with how everything went, would you mind leaving us a quick Google review? It only takes a minute, and it really helps other people find us.

[[button: Leave a Google review | {{business.google_review_link}}]]

And if you know anyone thinking about buying or refinancing, I'd be glad to help them too.

Kind regards,`;
// Short enough to stay one SMS with the opt-out line added.
const REVIEW_SMS = 'Hi {{contact.first_name}}, thanks again for choosing us! A quick Google review would mean a lot: {{business.google_review_link}} - {{broker.first_name}}';

const REVIEW_AUTOMATION = {
  name: 'Settled: ask for a Google review',
  description: 'Emails and texts the client a link to leave a Google review a couple of days after settlement (the "Review request" template). Clients marked as having left a review are skipped. Needs your Google review link in Settings → Business.',
  trigger: 'deal.stage_changed',
  conditions: [{ field: 'event.to_stage', op: 'eq', value: 'settled' }, { field: 'contact.google_reviewed_at', op: 'empty' }],
  actions: [{ type: 'send_email', template: 'Review request', delay_days: 2 }],
};

module.exports = { OLD_REVIEW_BODY, REVIEW_SUBJECT, REVIEW_BODY, REVIEW_SMS, REVIEW_AUTOMATION };
