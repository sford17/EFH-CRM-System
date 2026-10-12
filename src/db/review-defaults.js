'use strict';
// Email the broker when a client's annual review is coming up.
const REVIEW_REMINDER_AUTOMATIONS = [
  {
    name: 'Annual review coming up: email me',
    description: 'Emails the client\'s broker ahead of their annual review (their next review date, or the settlement anniversary), with a snapshot of the client to prepare from.',
    trigger: 'schedule.annual_review',
    trigger_config: { days_before: 14 },
    actions: [{ type: 'email_broker' }],
  },
];
module.exports = { REVIEW_REMINDER_AUTOMATIONS };
