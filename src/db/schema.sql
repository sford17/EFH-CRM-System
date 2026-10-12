-- EFH CRM schema. All dates are ISO-8601 strings: 'YYYY-MM-DD' for calendar
-- dates and full timestamps for *_at columns.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'broker' CHECK (role IN ('admin','broker','assistant')),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS referral_partners (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  company              TEXT,
  type                 TEXT NOT NULL DEFAULT 'other'
                       CHECK (type IN ('real_estate','accountant','financial_planner','solicitor','builder','past_client','other')),
  email                TEXT,
  phone                TEXT,
  referral_fee_pct     REAL NOT NULL DEFAULT 0, -- % of upfront commission paid to partner
  notes                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS lenders (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  upfront_pct     REAL NOT NULL DEFAULT 0.65, -- % of loan amount
  trail_pct       REAL NOT NULL DEFAULT 0.15, -- % p.a. of loan balance
  clawback_months INTEGER NOT NULL DEFAULT 24,
  bdm_name        TEXT,
  bdm_email       TEXT,
  bdm_phone       TEXT,
  notes           TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contacts (
  id                  INTEGER PRIMARY KEY,
  first_name          TEXT NOT NULL,
  last_name           TEXT,
  email               TEXT,
  mobile              TEXT,
  phone               TEXT,
  dob                 TEXT,
  address             TEXT,
  suburb              TEXT,
  state               TEXT,
  postcode            TEXT,
  employment_type     TEXT, -- payg, self_employed, contractor, retired, other
  employer            TEXT,
  annual_income       REAL,
  marital_status      TEXT,
  dependants          INTEGER,
  status              TEXT NOT NULL DEFAULT 'lead'
                      CHECK (status IN ('lead','prospect','client','past_client','lost')),
  lead_source         TEXT, -- website, referral, walk_in, social, repeat, other
  referral_partner_id INTEGER REFERENCES referral_partners(id) ON DELETE SET NULL,
  owner_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tags                TEXT NOT NULL DEFAULT '', -- comma separated
  marketing_opt_in    INTEGER NOT NULL DEFAULT 1,
  last_contacted_at   TEXT,
  next_review_date    TEXT,
  background          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);

CREATE TABLE IF NOT EXISTS deals (
  id                  INTEGER PRIMARY KEY,
  title               TEXT NOT NULL,
  contact_id          INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  co_borrower_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  loan_purpose        TEXT NOT NULL DEFAULT 'purchase'
                      CHECK (loan_purpose IN ('purchase','first_home','refinance','investment','construction','top_up','commercial','other')),
  property_address    TEXT,
  property_value      REAL,
  loan_amount         REAL,
  deposit             REAL,
  lender_id           INTEGER REFERENCES lenders(id) ON DELETE SET NULL,
  product_name        TEXT,
  interest_rate       REAL,
  rate_type           TEXT DEFAULT 'variable' CHECK (rate_type IN ('variable','fixed','split')),
  fixed_expiry_date   TEXT,
  loan_term_years     INTEGER DEFAULT 30,
  repayment_type      TEXT DEFAULT 'pi' CHECK (repayment_type IN ('pi','io')),
  stage               TEXT NOT NULL DEFAULT 'lead',
  stage_changed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  pre_approval_expiry TEXT,
  finance_due_date    TEXT,
  settlement_date     TEXT,
  application_ref     TEXT,
  lost_reason         TEXT,
  owner_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referral_partner_id INTEGER REFERENCES referral_partners(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id         INTEGER PRIMARY KEY,
  deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  due_date      TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  contact_id    INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  completed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(status, due_date);

CREATE TABLE IF NOT EXISTS activities (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id    INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note','call','email','sms','meeting','system')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(deal_id);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT,
  status      TEXT NOT NULL DEFAULT 'required' CHECK (status IN ('required','requested','received','verified','not_applicable')),
  link        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (deal_id, name)
);

CREATE TABLE IF NOT EXISTS email_templates (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  category   TEXT,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id            INTEGER PRIMARY KEY,
  to_email      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  contact_id    INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  template_id   INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','logged','failed','cancelled')),
  error         TEXT,
  send_after    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  trigger        TEXT NOT NULL,
  trigger_config TEXT NOT NULL DEFAULT '{}', -- JSON
  conditions     TEXT NOT NULL DEFAULT '[]', -- JSON [{field, op, value}]
  actions        TEXT NOT NULL DEFAULT '[]', -- JSON [{type, ...}]
  enabled        INTEGER NOT NULL DEFAULT 1,
  run_count      INTEGER NOT NULL DEFAULT 0,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            INTEGER PRIMARY KEY,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_key       TEXT UNIQUE, -- dedupes scheduled triggers
  entity_type   TEXT,
  entity_id     INTEGER,
  status        TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS commissions (
  id          INTEGER PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('upfront','trail','clawback','referral_fee','other')),
  amount      REAL NOT NULL, -- negative for clawbacks / referral fees paid out
  period      TEXT, -- YYYY-MM the amount relates to
  status      TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','received','paid','cancelled')),
  received_at TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_commissions_deal ON commissions(deal_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  link       TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
