-- Sessions of the Intra sign-in (src/sessions.ts), moved out of the KV
-- record where they were an array of tokens in clear next to the settings.
-- One row per signed-in browser: at most 10 per login (the newest are kept),
-- refused once older than 365 days. Only the SHA-256 (hex) of the token is
-- stored, so a dump of this table opens nothing. created_at is in
-- milliseconds, as GET /api/v1/private/sessions answers it.
CREATE TABLE IF NOT EXISTS sessions (
  login_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (login_hash, token_hash)
) WITHOUT ROWID;

-- Logins whose sessions live in the table above. The first request of a
-- login copies the tokens still listed in its KV record (hashed) and writes
-- this row in the same transaction; from then on the KV copy is never read
-- again. "Wipe all data" keeps the row: without it, a location still serving
-- the deleted record from its cache could copy the wiped sessions back.
CREATE TABLE IF NOT EXISTS session_migrations (
  login_hash TEXT PRIMARY KEY,
  migrated_at INTEGER NOT NULL
) WITHOUT ROWID;
