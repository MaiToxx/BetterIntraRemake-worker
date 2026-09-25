-- The whole schema of a fresh database, in one file. migrations/ is the
-- source of truth (`npx wrangler d1 migrations apply better-intra-d1`): this
-- file is what all of them add up to, and tests/migrations.test.ts fails
-- when the two differ. Everything is IF NOT EXISTS: running this file on a
-- database that already has these tables changes nothing.

-- One row per student who ever signed in (src/handlers/intra-auth.ts):
-- the login hash and the date of the first sign-in. Read only by
-- /api/v1/public/stats (community counter in the hub About tab) and deleted
-- by "Wipe all data". `country` is no longer written (rows made before
-- that may still hold the two-letter country of their first sign-in until
-- the operator runs `UPDATE users SET country = NULL`); the column stays so
-- no migration is needed. A database created by an earlier schema also
-- carries 42-application columns (forty_two_token, evals_enabled, campus_*,
-- pool...) that nothing reads any more.
CREATE TABLE IF NOT EXISTS users (
  hash TEXT PRIMARY KEY,
  country TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Project names, filled by the 42 API on deployments that had an
-- application. No longer read: the subject tracker answers `name: null`.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  subject_id TEXT,
  created_at INTEGER,
  modified_at INTEGER,
  last_changed_at INTEGER
);

CREATE TABLE IF NOT EXISTS calendar_ics (
  login_hash TEXT NOT NULL,
  ics_body TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (login_hash)
);

-- One live calendar link per login (revoked_at IS NULL); revoked tokens stay
-- as tombstones so they can never be registered again. Also created on first
-- use by src/handlers/calendar.ts.
CREATE TABLE IF NOT EXISTS calendar_tokens (
  token TEXT PRIMARY KEY,
  login_hash TEXT NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS calendar_tokens_login ON calendar_tokens (login_hash);

-- Sessions of the Intra sign-in (src/sessions.ts, migrations/0002): the
-- SHA-256 of each token, never the token; created_at in milliseconds. At
-- most 10 per login, refused once older than 365 days.
CREATE TABLE IF NOT EXISTS sessions (
  login_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (login_hash, token_hash)
) WITHOUT ROWID;

-- Logins whose sessions have been copied out of their KV record.
CREATE TABLE IF NOT EXISTS session_migrations (
  login_hash TEXT PRIMARY KEY,
  migrated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Daily KV write budget (src/budget.ts, migrations/0003): writes per UTC day
-- (days since the epoch) per login hash, and for the whole namespace ('*').
-- Kept two days.
CREATE TABLE IF NOT EXISTS kv_write_budget (
  day INTEGER NOT NULL,
  login_hash TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, login_hash)
) WITHOUT ROWID;

-- The public subset of each login's settings (src/public-visuals.ts,
-- migrations/0004), read by /api/v1/public/visuals before the KV record.
-- updated_at in milliseconds.
CREATE TABLE IF NOT EXISTS public_visuals (
  hash TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
