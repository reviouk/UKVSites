-- ukv-mailer schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS mailboxes (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  domain        TEXT NOT NULL,
  site          TEXT NOT NULL,            -- 'investchronicles' | 'marketwatcher'
  smtp_pass     TEXT,
  daily_cap     INT  NOT NULL DEFAULT 40,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_error    TEXT,
  last_error_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  company       TEXT,
  phone         TEXT,
  job_title     TEXT,
  postcode      TEXT,
  site          TEXT,                      -- which brand this contact is for
  data_source   TEXT,                      -- e.g. 'LUSHA LEADS' / spreadsheet label
  source_file   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | replied | bounced | unsubscribed | suppressed
  extra         JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_status_idx ON contacts(status);
CREATE INDEX IF NOT EXISTS contacts_source_idx ON contacts(data_source);

CREATE TABLE IF NOT EXISTS suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  site          TEXT NOT NULL,             -- which mailboxes/domain to send from + landing page
  status        TEXT NOT NULL DEFAULT 'paused',  -- active | paused | finished
  daily_cap     INT,                       -- optional per-campaign cap (NULL = no extra cap)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS steps (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position      INT NOT NULL,              -- 1,2,3...
  delay_days    INT NOT NULL DEFAULT 0,    -- days after previous step was sent (ignored for step 1)
  subject       TEXT NOT NULL,
  body_html     TEXT NOT NULL,
  reply_in_thread BOOLEAN NOT NULL DEFAULT TRUE,  -- follow-ups threaded under step 1
  UNIQUE (campaign_id, position)
);

CREATE TABLE IF NOT EXISTS enrolments (
  id            SERIAL PRIMARY KEY,
  campaign_id   INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id    INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  mailbox_id    INT REFERENCES mailboxes(id),     -- sticky: every step from the same persona
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | stopped
  stop_reason   TEXT,
  current_step  INT NOT NULL DEFAULT 0,
  next_due_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  thread_message_id TEXT,
  thread_subject TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS enrolments_due_idx ON enrolments(status, next_due_at);

CREATE TABLE IF NOT EXISTS sends (
  id            SERIAL PRIMARY KEY,
  token         TEXT UNIQUE NOT NULL,      -- used in tracking + unsubscribe URLs
  enrolment_id  INT NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  campaign_id   INT NOT NULL,
  contact_id    INT NOT NULL,
  mailbox_id    INT NOT NULL,
  step_position INT NOT NULL,
  message_id    TEXT,
  subject       TEXT,
  status        TEXT NOT NULL DEFAULT 'sent',   -- sent | failed | bounced
  error         TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at     TIMESTAMPTZ,
  clicked_at    TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sends_sent_at_idx ON sends(sent_at);
CREATE INDEX IF NOT EXISTS sends_mailbox_day_idx ON sends(mailbox_id, sent_at);
CREATE INDEX IF NOT EXISTS sends_message_id_idx ON sends(message_id);
CREATE INDEX IF NOT EXISTS sends_contact_idx ON sends(contact_id);

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  send_id     INT REFERENCES sends(id) ON DELETE CASCADE,
  contact_id  INT,
  type        TEXT NOT NULL,     -- open | click | reply | bounce | unsubscribe | hubspot_error
  detail      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_type_idx ON events(type, created_at);

CREATE TABLE IF NOT EXISTS replies (
  id          SERIAL PRIMARY KEY,
  send_id     INT REFERENCES sends(id) ON DELETE SET NULL,
  contact_id  INT,
  from_email  TEXT,
  subject     TEXT,
  snippet     TEXT,
  is_bounce   BOOLEAN NOT NULL DEFAULT FALSE,
  imap_uid    BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Added later: idempotent column additions
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instantly_contacted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instantly_status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instantly_campaign TEXT;
CREATE INDEX IF NOT EXISTS contacts_instantly_idx ON contacts(instantly_contacted);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS instantly_id TEXT UNIQUE;
ALTER TABLE steps ADD COLUMN IF NOT EXISTS preheader TEXT NOT NULL DEFAULT '';
ALTER TABLE sends ADD COLUMN IF NOT EXISTS bounce_type TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS conversion_event TEXT;
ALTER TABLE steps ADD COLUMN IF NOT EXISTS preheader TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS callback_events (
  id            SERIAL PRIMARY KEY,
  contact_id    TEXT NOT NULL,
  email         TEXT,
  owner_id      TEXT,
  callback_date TEXT NOT NULL,      -- YYYY-MM-DD (HubSpot call_back_date)
  kind          TEXT NOT NULL,      -- reminder | not_made | nightly_reset
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS callback_events_idx ON callback_events(contact_id, callback_date, kind);

ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS warmup_from DATE;  -- NULL = no warm-up schedule

-- Email verification (MillionVerifier bulk API; scripts/verify-emails.mjs)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verify_result  TEXT;         -- ok | catch_all | unknown | invalid | disposable | error
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verify_quality TEXT;         -- good | risky | bad
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verified_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS contacts_verify_idx ON contacts(verify_result);
-- Recipient mail provider (from the domain's MX; scripts/classify-mx.mjs) and per-provider routing.
-- Microsoft 365 / Outlook junk anything from Maildoso's relay (no PTR, in-addr.arpa HELO), so
-- contacts are routed to a mailbox *pool* per provider (settings route_<provider> = pool | hold).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mail_provider TEXT;       -- microsoft | google | yahoo | apple | gateway | other | none
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mx_host TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mx_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS contacts_provider_idx ON contacts(mail_provider);
CREATE TABLE IF NOT EXISTS mx_cache (
  domain     TEXT PRIMARY KEY,
  mx_host    TEXT,
  provider   TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS pool      TEXT NOT NULL DEFAULT 'maildoso';  -- which sending infrastructure
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS smtp_host TEXT;                              -- NULL = SMTP_HOST env
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS smtp_port INT;                               -- NULL = SMTP_PORT env

CREATE TABLE IF NOT EXISTS verify_jobs (
  file_id     TEXT PRIMARY KEY,                     -- MillionVerifier file id
  file_name   TEXT,
  emails      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | finished | imported | error
  summary     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at TIMESTAMPTZ
);
