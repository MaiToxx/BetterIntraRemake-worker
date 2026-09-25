import { Env } from "../types";
import { jsonRes, methodNotAllowedRes } from "../utils";

interface StatsBody {
  total: number;
  newToday: number;
  newLast30Days: number;
  newLast14Days: number;
  newLast7Days: number;
  countries: never[];
}

/**
 * How long an isolate serves the same counts. The route is public and
 * unlimited, and each count used to be its own scan of `users` (five scans,
 * `created_at` has no index): about 2,000 scripted GETs with 500 users spent
 * the 5M daily D1 row reads, and every D1 route (calendar feeds, calendar
 * links, the subject tracker, Wipe all data) answered 500 until midnight UTC.
 * Now it is one scan, at most once per isolate every 10 minutes. The Cache
 * API does nothing on workers.dev, hence the memory.
 */
export const STATS_CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; body: StatsBody } | null = null;

/** Test hook. */
export function resetStatsCache(): void {
  cached = null;
}

const DAY = 24 * 60 * 60;

async function readCounts(env: Env, nowSec: number): Promise<StatsBody> {
  const row = await env.better_intra_d1
    .prepare(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(created_at > ?), 0) AS today,
        COALESCE(SUM(created_at > ?), 0) AS d30,
        COALESCE(SUM(created_at > ?), 0) AS d14,
        COALESCE(SUM(created_at > ?), 0) AS d7
      FROM users`,
    )
    .bind(nowSec - (nowSec % DAY), nowSec - 30 * DAY, nowSec - 14 * DAY, nowSec - 7 * DAY)
    .first<{ total: number; today: number; d30: number; d14: number; d7: number }>();
  return {
    total: row?.total ?? 0,
    newToday: row?.today ?? 0,
    newLast30Days: row?.d30 ?? 0,
    newLast14Days: row?.d14 ?? 0,
    newLast7Days: row?.d7 ?? 0,
    // No country is stored any more (see handleIntraAuth). The field stays,
    // empty: extension builds up to 1.13.x read `countries.length` with no
    // guard, and a missing field would leave their About tab on a spinner.
    countries: [],
  };
}

export async function handleStats(
  request: Request,
  env: Env,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();

  if (!cached || now - cached.at >= STATS_CACHE_MS) {
    cached = { at: now, body: await readCounts(env, Math.floor(now / 1000)) };
  }
  return jsonRes(cached.body, 200, { "Cache-Control": "public, max-age=600" });
}
