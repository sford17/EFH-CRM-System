'use strict';
// Schema changes applied on top of schema.sql, in order. Each entry runs once;
// progress is tracked in SQLite's user_version so existing databases upgrade
// in place when a new version of the CRM starts.

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
];
