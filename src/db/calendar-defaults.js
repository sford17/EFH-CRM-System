'use strict';
// Default appointment automations, shared by first-time seeding and the
// migration that adds them to existing installs.

const CALENDAR_AUTOMATIONS = [
  {
    name: 'Appointment booked: prep task & alert', trigger: 'appointment.booked',
    description: 'When someone books through Calendly, alert the broker and add a prep task for the day of the meeting.',
    actions: [
      { type: 'create_task', title: 'Prepare for {{event.title}} with {{contact.full_name}} ({{event.when}})', due_on: 'event.date', due_in_days: 0 },
      { type: 'notify', message: 'New booking: {{contact.full_name}} – {{event.title}}, {{event.when}}' },
    ],
  },
  {
    name: 'Appointment cancelled: follow up', trigger: 'appointment.cancelled',
    description: 'When a client cancels (not reschedules) a Calendly booking.',
    actions: [
      { type: 'create_task', title: 'Follow up – {{contact.full_name}} cancelled {{event.title}} ({{event.when}})', due_in_days: 0, priority: 'high' },
      { type: 'notify', message: 'Cancelled: {{contact.full_name}} – {{event.title}}, {{event.when}}' },
    ],
  },
];

module.exports = { CALENDAR_AUTOMATIONS };
