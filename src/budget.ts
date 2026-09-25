import { Env } from "./types";
import { errorRes } from "./utils";

/**
 * Daily ceiling on KV writes, counted in D1 (migrations/0003_kv_write_budget.sql).
 *
 * The namespace shares 1,000 writes a day on the free plan and past that
 * every put throws until 00:00 UTC, for every student: no sign-in record, no
 * push, no upload. The rate limits (src/rate-limit.ts) only have one-minute
 * windows: 10 a minute per login is 14,400 a day, so one looping client, or
 * one buggy build, could spend the day's budget in under two hours, and
 * nothing said who. Counted in D1, which has no read replica (a KV counter
 * could be read 60 s stale by a loop) and allows 100,000 row writes a day:
 * at most two rows written per allowed KV write, none for a refusal.
 *
 * Counted: the KV writes a student can repeat (settings push, image upload,
 * the record a first sign-in creates). Not counted: deletes (a quota of their
 * own), the JWKS cache and the announcement (a few a day), and sign-out,
 * which no longer writes KV. The caps leave the rest of the 1,000 to those.
 */
export const DAILY_KV_WRITES_PER_LOGIN = 200;
export const DAILY_KV_WRITES = 900;
/**
 * Sign-ins may go further than pushes: a student who cannot sign in cannot
 * do anything, and a first sign-in's record is one write per new student.
 */
export const DAILY_KV_WRITES_SIGN_IN = 980;

/** The row counting the whole namespace (a login hash is 64 hex). */
export const BUDGET_ALL = "*";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since the epoch in UTC: KV's daily limits reset at 00:00 UTC. */
export const utcDay = (now: number): number => Math.floor(now / DAY_MS);

/**
 * One statement for both rows, so a refusal writes nothing: the source rows
 * (the login and '*') are only produced while both counts are under their
 * caps, and SQLite evaluates those reads before the first insert (the SELECT
 * reads the table being written, so its result is computed first). Past a
 * cap the upsert has no row to write and RETURNING answers none.
 */
const SPEND_SQL = `INSERT INTO kv_write_budget (day, login_hash, n)
SELECT ?1, who, 1 FROM (SELECT ?2 AS who UNION ALL SELECT '${BUDGET_ALL}')
WHERE COALESCE((SELECT n FROM kv_write_budget WHERE day = ?1 AND login_hash = ?2), 0) < ?3
  AND COALESCE((SELECT n FROM kv_write_budget WHERE day = ?1 AND login_hash = '${BUDGET_ALL}'), 0) < ?4
ON CONFLICT (day, login_hash) DO UPDATE SET n = n + 1
RETURNING login_hash, n`;

export interface SpendOptions {
  /** Cap of the namespace row: DAILY_KV_WRITES unless said otherwise. */
  globalCap?: number;
  now?: number;
}

/**
 * Spends one KV write of `loginHash` for today, before the put. False when
 * the login or the namespace is at its cap: the caller must not write. If D1
 * fails the write is allowed (and logged): the budget protects KV, it must
 * not take the writes down with it.
 */
export async function spendKvWrite(
  env: Env,
  loginHash: string,
  opts: SpendOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const day = utcDay(now);
  const db = env.better_intra_d1;
  let rows: { login_hash: string; n: number }[];
  try {
    ({ results: rows } = await db
      .prepare(SPEND_SQL)
      .bind(day, loginHash, DAILY_KV_WRITES_PER_LOGIN, opts.globalCap ?? DAILY_KV_WRITES)
      .all<{ login_hash: string; n: number }>());
  } catch (e) {
    console.warn(`[budget] count failed, write allowed: ${e}`);
    return true;
  }
  if (rows.length === 0) {
    await logRefusal(env, day, loginHash);
    return false;
  }
  // The first write of a UTC day prunes: yesterday stays, to tell who spent
  // the budget after an incident (SELECT * FROM kv_write_budget ORDER BY n DESC).
  if (rows.some((r) => r.login_hash === BUDGET_ALL && r.n === 1)) {
    try {
      await db.prepare("DELETE FROM kv_write_budget WHERE day < ?").bind(day - 1).run();
    } catch (e) {
      console.warn(`[budget] prune failed: ${e}`);
    }
  }
  return true;
}

/**
 * Names the login (its hash, shortened) and both counts in Workers Logs:
 * the rate limits made abuse slow but not attributable.
 */
async function logRefusal(env: Env, day: number, loginHash: string): Promise<void> {
  let counts = "?";
  try {
    const { results } = await env.better_intra_d1
      .prepare("SELECT login_hash, n FROM kv_write_budget WHERE day = ? AND login_hash IN (?, ?)")
      .bind(day, loginHash, BUDGET_ALL)
      .all<{ login_hash: string; n: number }>();
    const of = (who: string) => results.find((r) => r.login_hash === who)?.n ?? 0;
    counts = `login ${of(loginHash)}/${DAILY_KV_WRITES_PER_LOGIN}, all ${of(BUDGET_ALL)}`;
  } catch {}
  console.warn(`[budget] KV write refused for ${loginHash.slice(0, 12)}: ${counts}`);
}

/**
 * The refusal. 503, not 429: every extension build retries a 429 every 65 s
 * ("busy"), which would go on all day at one KV read a try, while any other
 * 5xx is "rejected", retried three times by the hub at most.
 */
export function budgetRes(now: number = Date.now()): Response {
  const retryAfter = Math.ceil(((utcDay(now) + 1) * DAY_MS - now) / 1000);
  return errorRes(
    "daily_write_budget",
    "Daily write budget reached, try again after 00:00 UTC",
    503,
    { "Retry-After": String(retryAfter) },
  );
}
