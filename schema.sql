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

-- Project names shown by the subject tracker. Filled by the 42 API on
-- deployments that had an application; read-only here (an empty table only
-- leaves `name` null in the tracker's answers).
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
