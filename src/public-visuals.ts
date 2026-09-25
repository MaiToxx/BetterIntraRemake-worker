import { Env, UserData } from "./types";

/**
 * The public subset of each login's settings in D1
 * (migrations/0004_public_visuals.sql), which /api/v1/public/visuals reads
 * before the KV record. That route is anonymous and its batch form names up
 * to 50 logins a call: from KV, each one was a read of a whole record (up to
 * 256 KB) out of the 100,000 a day, made-up hashes included. A D1 row read
 * costs one of 5,000,000. What is stored is the raw keys publicVisuals()
 * reads (see publicSubset in src/handlers/settings.ts), not its output, so
 * that a change to what is published needs no rewrite of the rows.
 *
 * Only a settings push writes a row: when those keys changed, or when the
 * row it finds says something else than the record it writes (see
 * refreshPublicRow). A login that has not pushed such a change since this
 * table exists has no row and is served from its KV record as before. No backfill: it would
 * spend a KV read per record and a live-data operation for nothing a push
 * does not do on its own.
 */

/**
 * Stored subsets of `hashes` (the ones that have a row), or null when D1
 * failed: the callers then read KV, as before this table existed. A row that
 * does not parse counts as missing.
 */
export async function readPublicRows(
  env: Env,
  hashes: string[],
): Promise<Map<string, Record<string, unknown>> | null> {
  if (hashes.length === 0) return new Map();
  let results: { hash: string; settings: string }[];
  try {
    ({ results } = await env.better_intra_d1
      .prepare(
        `SELECT hash, settings FROM public_visuals WHERE hash IN (${hashes.map(() => "?").join(", ")})`,
      )
      .bind(...hashes)
      .all<{ hash: string; settings: string }>());
  } catch (e) {
    console.warn(`[public-visuals] D1 read failed, serving from KV: ${e}`);
    return null;
  }
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of results) {
    try {
      const parsed = JSON.parse(row.settings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.set(row.hash, parsed);
      }
    } catch {}
  }
  return rows;
}

/**
 * What the public routes render for one login: its D1 row, else its KV
 * record (read through `record` only then).
 */
export async function publicRecord(
  env: Env,
  hash: string,
  record: () => Promise<UserData | null>,
): Promise<UserData | null> {
  const row = (await readPublicRows(env, [hash]))?.get(hash);
  return row ? { settings: row } : record();
}

/** Stores the subset `json` (publicSubset output, serialized) for `hash`. */
export async function writePublicRow(
  env: Env,
  hash: string,
  json: string,
  now: number = Date.now(),
): Promise<void> {
  await env.better_intra_d1
    .prepare(
      "INSERT INTO public_visuals (hash, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at",
    )
    .bind(hash, json, now)
    .run();
}

/**
 * Puts `json` in the row of `hash` when the login has one that says
 * something else; never creates one. For a push whose public subset equals
 * the record it read: that read can be a copy KV served stale (up to 60 s
 * old), or the record a push cut short between its two writes left behind
 * its row. Compared with that record alone, going back to a look found
 * nothing to write, and visitors kept the other one for good. True when the
 * row changed. Best effort: a repair must not fail the push (a D1 error is
 * logged, and the row is compared again by the next push).
 */
export async function refreshPublicRow(
  env: Env,
  hash: string,
  json: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const { meta } = await env.better_intra_d1
      .prepare(
        "UPDATE public_visuals SET settings = ?, updated_at = ? WHERE hash = ? AND settings <> ?",
      )
      .bind(json, now, hash, json)
      .run();
    return (meta.changes ?? 0) > 0;
  } catch (e) {
    console.warn(`[public-visuals] row not compared with the push: ${e}`);
    return false;
  }
}

/** "Wipe all data": the row goes with the record. */
export function deletePublicRowStatement(env: Env, hash: string): D1PreparedStatement {
  return env.better_intra_d1
    .prepare("DELETE FROM public_visuals WHERE hash = ?")
    .bind(hash);
}
