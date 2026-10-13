'use strict';
// Online fact find automations: one to send it when a deal reaches the Fact
// Find stage (off until the broker switches it on), and a review task when
// the client finishes.

const FACT_FIND_AUTOMATIONS = [
  {
    name: 'Fact Find stage: send the online fact find',
    description: 'Emails the client a link to the online fact find (with document uploads) when a deal moves to Fact Find. Switch it on when your CRM web address is set up for clients.',
    trigger: 'deal.stage_changed',
    conditions: [{ field: 'event.to_stage', op: 'eq', value: 'fact_find' }],
    actions: [{ type: 'send_fact_find', kind: 'full' }],
    enabled: 0,
  },
  {
    name: 'Fact find completed: review it',
    description: 'Creates a task to review and import the client\'s answers and documents.',
    trigger: 'fact_find.submitted',
    conditions: [],
    actions: [{ type: 'create_task', title: 'Review {{contact.first_name}}\'s online fact find and documents', due_in_days: 1, priority: 'high' }],
  },
];

module.exports = { FACT_FIND_AUTOMATIONS };
