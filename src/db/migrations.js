'use strict';
// Schema changes applied on top of schema.sql, in order. Each entry runs once;
// progress is tracked in SQLite's user_version so existing databases upgrade
// in place when a new version of the CRM starts. An entry is either SQL or a
// function receiving the db helpers.
const { STAGE_SMS, BIRTHDAY_SMS, SMS_AUTOMATIONS, TEMPLATE_SMS, RATE_REDUCTION_TEMPLATE } = require('./sms-defaults');

module.exports = [
  // 1. Outlook email sync
  `
  CREATE TABLE mail_accounts (
    id               INTEGER PRIMARY KEY,
    user_id          INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT NOT NULL DEFAULT 'outlook',
    email            TEXT,
    display_name     TEXT,
    access_token     TEXT,  -- encrypted
    refresh_token    TEXT,  -- encrypted
    token_expires_at TEXT,
    connected        INTEGER NOT NULL DEFAULT 1,
    last_sync_at     TEXT,
    sync_error       TEXT,
    connected_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE oauth_states (
    state        TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier     TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );

  CREATE TABLE emails (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    graph_id        TEXT NOT NULL,
    conversation_id TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
    from_email      TEXT,
    from_name       TEXT,
    to_emails       TEXT,
    cc_emails       TEXT,
    subject         TEXT,
    body_text       TEXT,
    preview         TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    web_link        TEXT,
    deal_id         INTEGER REFERENCES deals(id) ON DELETE SET NULL,
    sent_at         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (account_id, graph_id)
  );
  CREATE INDEX idx_emails_sent ON emails(sent_at);

  CREATE TABLE email_contacts (
    email_id   INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    PRIMARY KEY (email_id, contact_id)
  );
  CREATE INDEX idx_email_contacts_contact ON email_contacts(contact_id);

  ALTER TABLE outbox ADD COLUMN sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE outbox ADD COLUMN sent_via TEXT;
  ALTER TABLE activities ADD COLUMN email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL;
  `,

  // 2. SMS
  (db) => {
    db.get().exec(`
      CREATE TABLE sms_messages (
        id             INTEGER PRIMARY KEY,
        to_number      TEXT NOT NULL,
        from_number    TEXT,
        body           TEXT NOT NULL,
        contact_id     INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        deal_id        INTEGER REFERENCES deals(id) ON DELETE SET NULL,
        template_id    INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
        automation_id  INTEGER REFERENCES automations(id) ON DELETE SET NULL,
        sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','logged','failed','cancelled')),
        provider_id    TEXT,
        error          TEXT,
        send_after     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        sent_at        TEXT,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_sms_contact ON sms_messages(contact_id);
      ALTER TABLE contacts ADD COLUMN sms_opt_out INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN sms_from TEXT;
      ALTER TABLE email_templates ADD COLUMN sms_body TEXT;
    `);

    // Existing installs: add SMS to the default automations and templates.
    // (Fresh installs get them from the seed data instead.)
    if (db.getSetting('automations_seeded')) {
      const addSms = (name, action) => {
        const row = db.one('SELECT id, actions FROM automations WHERE name = ?', name);
        if (!row) return;
        const actions = JSON.parse(row.actions);
        if (actions.some((a) => a.type === 'send_sms')) return;
        db.update('automations', row.id, { actions: JSON.stringify([...actions, action]) });
      };
      for (const [name, message] of Object.entries(STAGE_SMS)) addSms(name, { type: 'send_sms', message });
      addSms(BIRTHDAY_SMS.automation, { type: 'send_sms', message: BIRTHDAY_SMS.message, marketing: true });
      for (const a of SMS_AUTOMATIONS) {
        if (db.one('SELECT 1 FROM automations WHERE name = ?', a.name)) continue;
        db.insert('automations', {
          name: a.name, description: a.description || null, trigger: a.trigger,
          conditions: JSON.stringify(a.conditions || []), actions: JSON.stringify(a.actions),
        });
      }
    }
    if (db.one('SELECT 1 FROM email_templates LIMIT 1')) {
      const [name, category, subject, body] = RATE_REDUCTION_TEMPLATE;
      if (!db.one('SELECT 1 FROM email_templates WHERE name = ?', name)) db.insert('email_templates', { name, category, subject, body });
      for (const [tname, sms] of Object.entries(TEMPLATE_SMS)) {
        db.run('UPDATE email_templates SET sms_body = ? WHERE name = ? AND sms_body IS NULL', sms, tname);
      }
    }
  },
];
