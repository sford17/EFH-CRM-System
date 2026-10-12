'use strict';
// Schema changes applied on top of schema.sql, in order. Each entry runs once;
// progress is tracked in SQLite's user_version so existing databases upgrade
// in place when a new version of the CRM starts. An entry is either SQL or a
// function receiving the db helpers.
const { STAGE_SMS, BIRTHDAY_SMS, SMS_AUTOMATIONS, TEMPLATE_SMS, RATE_REDUCTION_TEMPLATE } = require('./sms-defaults');
const { CALENDAR_AUTOMATIONS } = require('./calendar-defaults');
const { IO_EXPIRY_AUTOMATION, FIXED_RATE_TEXT_UPDATES } = require('./tracker-defaults');

// Existing installs: add SMS to the default automations and templates.
// (Fresh installs get them from the seed data instead.)
function addSmsDefaults(db) {
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
}

function addCalendarDefaults(db) {
  if (db.getSetting('automations_seeded')) {
    for (const a of CALENDAR_AUTOMATIONS) {
      if (db.one('SELECT 1 FROM automations WHERE name = ?', a.name)) continue;
      db.insert('automations', {
        name: a.name, description: a.description || null, trigger: a.trigger,
        conditions: JSON.stringify(a.conditions || []), actions: JSON.stringify(a.actions),
      });
    }
  }
}

// Existing installs: move fixed-rate wording to tracker loans, add the IO
// automation, and copy every settled deal into the tracker.
function addTrackerDefaults(db) {
  const swap = (text) => FIXED_RATE_TEXT_UPDATES.reduce((t, [from, to]) => t.split(from).join(to), text);
  const fixedTemplate = db.one("SELECT id, subject, body FROM email_templates WHERE name = 'Fixed rate expiry review'");
  if (fixedTemplate) db.update('email_templates', fixedTemplate.id, { subject: swap(fixedTemplate.subject), body: swap(fixedTemplate.body) });
  const fixedAuto = db.one("SELECT id, actions FROM automations WHERE trigger = 'schedule.fixed_rate_expiry' AND name = 'Fixed rate expiring in 90 days'");
  if (fixedAuto) db.update('automations', fixedAuto.id, { actions: swap(fixedAuto.actions) });
  if (db.getSetting('automations_seeded') && !db.one('SELECT 1 FROM automations WHERE name = ?', IO_EXPIRY_AUTOMATION.name)) {
    const a = IO_EXPIRY_AUTOMATION;
    db.insert('automations', {
      name: a.name, description: a.description, trigger: a.trigger, trigger_config: JSON.stringify(a.trigger_config),
      conditions: '[]', actions: JSON.stringify(a.actions),
    });
  }
  const tracker = require('../services/tracker');
  for (const d of db.all("SELECT id FROM deals WHERE stage = 'settled'")) tracker.createFromDeal(d.id);
  // Fixed-rate reminders already sent for a deal count as sent for its loan.
  for (const run of db.all("SELECT r.run_key FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE a.trigger = 'schedule.fixed_rate_expiry' AND r.run_key LIKE '%:deal:%'")) {
    const [autoId, , dealId, ...k] = run.run_key.split(':');
    const loan = db.one('SELECT id FROM loans WHERE deal_id = ?', Number(dealId));
    if (!loan) continue;
    const key = `${autoId}:loan:${loan.id}:${k.join(':')}`;
    if (!db.one('SELECT 1 FROM automation_runs WHERE run_key = ?', key)) {
      db.insert('automation_runs', { automation_id: Number(autoId), run_key: key, entity_type: 'loan', entity_id: loan.id, status: 'skipped', detail: 'Already sent before the mortgage tracker' });
    }
  }
}

const MIGRATIONS = [
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

    addSmsDefaults(db);
  },

  // 3. Branding and email signatures
  (db) => {
    db.get().exec(`
      CREATE TABLE assets (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL,          -- logo | signature
        mime       TEXT NOT NULL,
        data       BLOB NOT NULL,
        width      INTEGER,
        height     INTEGER,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      ALTER TABLE users ADD COLUMN signature_html TEXT;
    `);
    // The sign-off now comes from each sender's signature, so drop the old
    // plain-text one from templates nobody has edited.
    const oldSignoff = '\n\nKind regards,\n{{broker.name}}\n{{business.name}}\n{{broker.phone}}';
    for (const t of db.all('SELECT id, body FROM email_templates')) {
      if (t.body.endsWith(oldSignoff)) {
        db.update('email_templates', t.id, { body: `${t.body.slice(0, -oldSignoff.length)}\n\nKind regards,` });
      }
    }
  },

  // 4. Calendly appointments
  (db) => {
    db.get().exec(`
      CREATE TABLE calendly_accounts (
        id             INTEGER PRIMARY KEY,
        user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        token          TEXT,  -- encrypted personal access token
        user_uri       TEXT,
        name           TEXT,
        email          TEXT,
        scheduling_url TEXT,
        connected      INTEGER NOT NULL DEFAULT 1,
        last_sync_at   TEXT,
        sync_error     TEXT,
        connected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE appointments (
        id                  INTEGER PRIMARY KEY,
        source              TEXT NOT NULL DEFAULT 'calendly',
        external_uri        TEXT UNIQUE,
        user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
        title               TEXT NOT NULL,
        start_at            TEXT NOT NULL,
        end_at              TEXT,
        status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','canceled')),
        location_type       TEXT,
        location            TEXT,
        join_url            TEXT,
        invitee_name        TEXT,
        invitee_email       TEXT,
        invitee_phone       TEXT,
        contact_id          INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        deal_id             INTEGER REFERENCES deals(id) ON DELETE SET NULL,
        cancel_url          TEXT,
        reschedule_url      TEXT,
        notes               TEXT,
        cancel_reason       TEXT,
        rescheduled         INTEGER NOT NULL DEFAULT 0,
        external_updated_at TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_appointments_start ON appointments(start_at);
      CREATE INDEX idx_appointments_contact ON appointments(contact_id);
    `);
    addCalendarDefaults(db);
  },

  // 5. Spreadsheet imports (with undo)
  `
  CREATE TABLE imports (
    id               INTEGER PRIMARY KEY,
    filename         TEXT,
    sheet            TEXT,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    contacts_created INTEGER NOT NULL DEFAULT 0,
    contacts_updated INTEGER NOT NULL DEFAULT 0,
    deals_created    INTEGER NOT NULL DEFAULT 0,
    skipped          INTEGER NOT NULL DEFAULT 0,
    held_automations INTEGER NOT NULL DEFAULT 0,
    options          TEXT,
    undone_at        TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  ALTER TABLE contacts ADD COLUMN import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL;
  ALTER TABLE deals ADD COLUMN import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL;
  `,
];

MIGRATIONS.push(
  // 6. Mortgage tracker: properties, valuations, loans & securities, other assets
  (db) => {
    db.get().exec(`
      CREATE TABLE properties (
        id                   INTEGER PRIMARY KEY,
        contact_id           INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        co_owner_id          INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        address              TEXT NOT NULL,
        suburb               TEXT,
        state                TEXT,
        postcode             TEXT,
        property_type        TEXT NOT NULL DEFAULT 'house' CHECK (property_type IN ('house','unit','townhouse','land','rural','commercial','other')),
        usage                TEXT NOT NULL DEFAULT 'owner_occupied' CHECK (usage IN ('owner_occupied','investment','holiday','vacant','business','other')),
        bedrooms             INTEGER,
        purchase_date        TEXT,
        purchase_price       REAL,
        rental_income_weekly REAL,
        status               TEXT NOT NULL DEFAULT 'owned' CHECK (status IN ('owned','purchasing','sold')),
        notes                TEXT,
        deal_id              INTEGER REFERENCES deals(id) ON DELETE SET NULL,
        import_id            INTEGER REFERENCES imports(id) ON DELETE SET NULL,
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_properties_contact ON properties(contact_id);

      CREATE TABLE valuations (
        id             INTEGER PRIMARY KEY,
        property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        valuation_date TEXT NOT NULL,
        amount         REAL NOT NULL,
        method         TEXT NOT NULL CHECK (method IN ('full','desktop','kerbside','avm','contract_price','agent_appraisal','client_estimate','other')),
        provider       TEXT,
        lender_id      INTEGER REFERENCES lenders(id) ON DELETE SET NULL,
        reference      TEXT,
        notes          TEXT,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_valuations_property ON valuations(property_id, valuation_date);

      CREATE TABLE loans (
        id                  INTEGER PRIMARY KEY,
        contact_id          INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        co_borrower_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        deal_id             INTEGER REFERENCES deals(id) ON DELETE CASCADE,
        lender_id           INTEGER REFERENCES lenders(id) ON DELETE SET NULL,
        lender_name         TEXT,
        loan_type           TEXT NOT NULL DEFAULT 'home_loan'
                            CHECK (loan_type IN ('home_loan','investment_loan','line_of_credit','construction','bridging','commercial','personal','car','credit_card','hecs','other')),
        account_number      TEXT,
        product_name        TEXT,
        limit_amount        REAL,
        balance             REAL,
        balance_date        TEXT,
        interest_rate       REAL,
        rate_type           TEXT NOT NULL DEFAULT 'variable' CHECK (rate_type IN ('variable','fixed','split')),
        fixed_expiry_date   TEXT,
        repayment_type      TEXT NOT NULL DEFAULT 'pi' CHECK (repayment_type IN ('pi','io')),
        io_expiry_date      TEXT,
        repayment_amount    REAL,
        repayment_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (repayment_frequency IN ('weekly','fortnightly','monthly')),
        offset_balance      REAL,
        settlement_date     TEXT,
        loan_term_years     INTEGER,
        status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discharged','refinanced')),
        arranged_by_us      INTEGER NOT NULL DEFAULT 1,
        notes               TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_loans_contact ON loans(contact_id);
      CREATE INDEX idx_loans_fixed ON loans(status, fixed_expiry_date);

      CREATE TABLE loan_securities (
        loan_id     INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
        property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        PRIMARY KEY (loan_id, property_id)
      );

      CREATE TABLE client_assets (
        id          INTEGER PRIMARY KEY,
        contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        asset_type  TEXT NOT NULL DEFAULT 'savings' CHECK (asset_type IN ('savings','superannuation','shares','vehicle','business','contents','other')),
        description TEXT,
        institution TEXT,
        value       REAL,
        value_date  TEXT,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    addTrackerDefaults(db);
  },
);

MIGRATIONS.push(
  // 7. Client lending review documents; email attachments
  `
  CREATE TABLE reviews (
    id                  INTEGER PRIMARY KEY,
    contact_id          INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    title               TEXT NOT NULL DEFAULT 'Client Lending Review',
    review_date         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
    snapshot            TEXT NOT NULL,
    loan_review         TEXT,
    actions_to_consider TEXT,
    broker_to_action    TEXT,
    next_steps          TEXT,
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sent_at             TEXT,
    sent_to             TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_reviews_contact ON reviews(contact_id);
  ALTER TABLE outbox ADD COLUMN attachments TEXT; -- JSON [{ filename, mime, data (base64) }]
  `,
);

// Lender websites, so a logo can be fetched with one click.
const LENDER_WEBSITES = {
  ANZ: 'anz.com.au', 'Commonwealth Bank': 'commbank.com.au', NAB: 'nab.com.au', Westpac: 'westpac.com.au', 'Macquarie Bank': 'macquarie.com.au',
  ING: 'ing.com.au', 'St.George': 'stgeorge.com.au', Suncorp: 'suncorp.com.au', Bankwest: 'bankwest.com.au', 'Bank of Queensland': 'boq.com.au',
  'Pepper Money': 'pepper.com.au', Liberty: 'liberty.com.au',
};

MIGRATIONS.push(
  // 8. Lender logos
  (db) => {
    db.get().exec(`
      ALTER TABLE lenders ADD COLUMN logo_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL;
      ALTER TABLE lenders ADD COLUMN website TEXT;
    `);
    for (const [name, site] of Object.entries(LENDER_WEBSITES)) db.run('UPDATE lenders SET website = ? WHERE name = ? AND website IS NULL', site, name);
  },
);

MIGRATIONS.push(
  // 9. Related contacts / households; review addressees
  `
  CREATE TABLE contact_relationships (
    id              INTEGER PRIMARY KEY,
    contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    related_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    relationship    TEXT NOT NULL DEFAULT 'spouse' CHECK (relationship IN
                    ('spouse','de_facto','partner','parent','child','sibling','relative','business_partner','guarantor','accountant','solicitor','other')),
    shared_finances INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (contact_id, related_id),
    CHECK (contact_id != related_id)
  );
  CREATE INDEX idx_relationships_related ON contact_relationships(related_id);
  ALTER TABLE reviews ADD COLUMN addressee_ids TEXT; -- JSON array of contact ids
  `,
);

module.exports = MIGRATIONS;
module.exports.LENDER_WEBSITES = LENDER_WEBSITES;
module.exports.addSmsDefaults = addSmsDefaults;
module.exports.addCalendarDefaults = addCalendarDefaults;
module.exports.addTrackerDefaults = addTrackerDefaults;
