-- What visitors of a profile are served (src/public-visuals.ts): the
-- settings keys /api/v1/public/visuals reads, as JSON, per login hash. The
-- public routes used to read the whole KV record, up to 50 per anonymous
-- call, out of the 100,000 KV reads a day. Written by a settings push only
-- when those keys change, deleted by "Wipe all data". A login without a row
-- (not pushed a public change since this table exists) is still served from
-- its KV record.
CREATE TABLE IF NOT EXISTS public_visuals (
  hash TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
