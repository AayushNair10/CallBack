-- Callback schema (Cloudflare D1 / SQLite)
-- D1 enforces foreign keys by default.

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company     TEXT NOT NULL,
  role        TEXT,
  location    TEXT,
  pay_min     REAL,
  pay_max     REAL,
  pay_unit    TEXT CHECK (pay_unit IS NULL OR pay_unit IN ('HOUR', 'WEEK', 'MONTH', 'YEAR')),
  currency    TEXT,
  url         TEXT UNIQUE,
  aliases     TEXT,  -- comma-separated names used to match emails
  status      TEXT NOT NULL DEFAULT 'applied'
              CHECK (status IN ('saved', 'applied', 'oa', 'interview', 'offer', 'rejected')),
  notes       TEXT,
  applied_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Metadata only: email bodies are never stored.
CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_id     TEXT UNIQUE NOT NULL,
  thread_id    TEXT,
  from_name    TEXT,
  from_addr    TEXT,
  from_domain  TEXT,
  subject      TEXT,
  received_at  TEXT NOT NULL,
  category     TEXT NOT NULL,
  job_id       INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  link         TEXT,  -- OA / scheduling link
  in_spam      INTEGER DEFAULT 0,
  notified     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id   ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_job_id      ON emails(job_id);

-- Append-only status history.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  email_id    INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);
