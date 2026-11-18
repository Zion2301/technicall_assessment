import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Many of our correctness guarantees live in this schema, not in application
 * code. UNIQUE constraints are the last line of defence against double-paying
 * even if application logic has a bug.
 *
 * Conventions: timestamps are epoch milliseconds (INTEGER); money is integer
 * minor units plus a currency column.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,     -- detects "same key, different request"
  funding_currency  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (company_id, idempotency_key)
);

-- One locked FX quote per currency in the run. The rate never changes after
-- creation, so retries weeks later still use the rate the company agreed to.
CREATE TABLE IF NOT EXISTS fx_quotes (
  id                   TEXT PRIMARY KEY,
  payroll_run_id       TEXT NOT NULL REFERENCES payroll_runs(id),
  from_currency        TEXT NOT NULL,
  to_currency          TEXT NOT NULL,
  rate                 TEXT NOT NULL,  -- decimal string, never a float
  source               TEXT NOT NULL,
  target_total_minor   INTEGER NOT NULL,  -- total local currency to pay out
  funding_minor        INTEGER NOT NULL,  -- what the company must fund (rounded up)
  locked_at            INTEGER NOT NULL,
  UNIQUE (payroll_run_id, from_currency, to_currency)
);

CREATE TABLE IF NOT EXISTS payouts (
  id               TEXT PRIMARY KEY,
  payroll_run_id   TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id      TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'GHS')),
  provider         TEXT NOT NULL,
  recipient_json   TEXT NOT NULL,     -- snapshot of where the money is going
  status           TEXT NOT NULL CHECK (status IN
                     ('pending', 'processing', 'awaiting_retry', 'succeeded', 'failed', 'needs_review')),
  next_attempt_at  INTEGER,           -- when a retry becomes due
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (payroll_run_id, employee_id) -- an employee is paid at most once per run
);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts (status, next_attempt_at);

-- Every call (or possible call) to a provider. A new row = a new provider
-- reference, which we only create once the previous attempt definitely failed.
CREATE TABLE IF NOT EXISTS payout_attempts (
  id                  TEXT PRIMARY KEY,
  payout_id           TEXT NOT NULL REFERENCES payouts(id),
  attempt_number      INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  provider_reference  TEXT NOT NULL UNIQUE,  -- our idempotency key towards the provider
  status              TEXT NOT NULL CHECK (status IN
                        ('in_flight', 'accepted', 'unknown', 'succeeded', 'failed')),
  failure_code        TEXT,
  failure_retryable   INTEGER,               -- 0/1, only set when status = 'failed'
  status_checks       INTEGER NOT NULL DEFAULT 0,
  raw_response        TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (payout_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_attempts_status ON payout_attempts (status, updated_at);

-- Audit trail: answers "what happened to this salary, and why?"
CREATE TABLE IF NOT EXISTS payout_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payout_id    TEXT NOT NULL REFERENCES payouts(id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL,   -- processor | webhook | reconciler | operator | api
  reason       TEXT NOT NULL,
  metadata     TEXT,            -- JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_payout ON payout_events (payout_id, id);

-- Double-entry ledger: every txn_id has entries that sum to zero per currency.
-- Answers "where is the money right now?"
-- txn_id is deterministic ("settle:<payout_id>"), so UNIQUE(txn_id, account)
-- makes it physically impossible to settle or refund the same payout twice.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id        TEXT NOT NULL,
  account       TEXT NOT NULL,
  currency      TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor <> 0),  -- signed: +debit / -credit
  payout_id     TEXT REFERENCES payouts(id),
  description   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (txn_id, account)
);
CREATE INDEX IF NOT EXISTS idx_ledger_payout ON ledger_entries (payout_id);

-- Inbound webhooks. The UNIQUE constraint is what makes duplicates harmless.
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  payload            TEXT NOT NULL,
  outcome            TEXT NOT NULL,
  received_at        INTEGER NOT NULL,
  UNIQUE (provider, provider_event_id)
);

-- Append-only: history can be added to, never rewritten.
CREATE TRIGGER IF NOT EXISTS payout_events_no_update BEFORE UPDATE ON payout_events
  BEGIN SELECT RAISE(ABORT, 'payout_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS payout_events_no_delete BEFORE DELETE ON payout_events
  BEGIN SELECT RAISE(ABORT, 'payout_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries
  BEGIN SELECT RAISE(ABORT, 'ledger_entries is append-only'); END;
`;

/** Opens a database (in-memory by default, which is what tests use) and applies the schema. */
export function openDb(filename = ':memory:'): DB {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  if (filename !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
