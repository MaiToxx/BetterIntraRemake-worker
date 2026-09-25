-- Daily ceiling on KV writes (src/budget.ts). The namespace shares 1,000
-- writes a day on the free plan, and past that every put throws, for every
-- user, until 00:00 UTC; the per-minute rate limits allow far more than that
-- in a day. One row per UTC day (`day` = days since the epoch) and login
-- hash, plus the row '*' counting the whole namespace: a sign-in record, a
-- settings push or an image upload first spends one here, and is refused
-- (503 daily_write_budget) once the login or the namespace is at its cap. D1
-- has no read replica, so the count is exact wherever the request lands.
-- Rows older than yesterday are deleted by the first write of each day, and
-- yesterday's say who spent the budget after an incident.
CREATE TABLE IF NOT EXISTS kv_write_budget (
  day INTEGER NOT NULL,
  login_hash TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, login_hash)
) WITHOUT ROWID;
