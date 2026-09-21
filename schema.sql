CREATE TABLE IF NOT EXISTS users (
  hash TEXT PRIMARY KEY,
  forty_two_token TEXT,
  forty_two_user_id INTEGER,
  evals_enabled INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER,
  country TEXT,
  campus_id INTEGER,
  campus_name TEXT,
  pool TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS eval_users (
  hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS eval_states (
  hash TEXT NOT NULL,
  eval_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('evaluator')),
  state TEXT NOT NULL CHECK(state IN ('booked', 'revealed')),
  project_id INTEGER,
  notified_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  begin_at TEXT,
  PRIMARY KEY (hash, eval_id, role)
);

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

CREATE TABLE IF NOT EXISTS correction_point_historics (
  hash TEXT NOT NULL,
  historic_id INTEGER NOT NULL,
  sum INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hash, historic_id)
);

CREATE TABLE IF NOT EXISTS outstanding_projects (
  hash TEXT NOT NULL,
  scale_team_id INTEGER NOT NULL,
  projects_user_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (hash, scale_team_id)
);

CREATE TABLE IF NOT EXISTS outstanding_sync_state (
  hash TEXT PRIMARY KEY,
  completed_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS eval_stats_cache (
  target_login TEXT NOT NULL,
  response_body TEXT NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (target_login)
);

CREATE TABLE IF NOT EXISTS profile_stats_cache (
  target_login TEXT NOT NULL,
  response_body TEXT NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (target_login)
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

CREATE TABLE IF NOT EXISTS logtime_history (
  login TEXT PRIMARY KEY,
  days_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS cursus (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch())
);
