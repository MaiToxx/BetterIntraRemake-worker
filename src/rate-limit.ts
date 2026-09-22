import { Env } from "./types";
import { textRes } from "./utils";

/**
 * Two buckets, both sliding over one minute:
 *
 *  - "write", keyed by login hash: every route that writes the user's data
 *    (sign-in once the token is verified, settings push, session removal,
 *    calendar link and calendar upload). The KV namespace shares 1,000 writes
 *    a day on the free plan and past the limit every put throws for everyone
 *    until midnight UTC, so one client replaying its own valid token, or
 *    pushing distinct payloads in a loop, must stay slow. 10 a minute is far
 *    above any real use (sign-in is a click, a push is a hub action).
 *  - "anon", keyed by client IP: the unauthenticated /auth/intra before any
 *    JWKS work, so garbage POSTs cannot make the worker hammer auth.42.fr.
 *    A campus sits behind one NAT, hence the higher limit; nothing else is
 *    keyed by IP for the same reason.
 *
 * Neither makes the daily budget unexhaustible: they make abuse slow and
 * attributable. The Workers rate limit bindings (wrangler.json "ratelimits")
 * are used when bound; without them (local dev, tests, a fork that did not
 * add them) a fixed window per isolate stands in. Both are best effort per
 * colo or per isolate, never a global counter.
 */
export type Bucket = "write" | "anon";

export const LIMITS: Record<Bucket, { limit: number; periodMs: number }> = {
  write: { limit: 10, periodMs: 60_000 },
  anon: { limit: 30, periodMs: 60_000 },
};

const BINDING: Record<Bucket, keyof Pick<Env, "WRITE_RL" | "ANON_RL">> = {
  write: "WRITE_RL",
  anon: "ANON_RL",
};

interface Window {
  count: number;
  resetAt: number;
}

const windows: Record<Bucket, Map<string, Window>> = {
  write: new Map(),
  anon: new Map(),
};

/** Bounded memory: expired windows go on every pass once the map is large. */
const PRUNE_ABOVE = 5_000;

function localLimited(bucket: Bucket, key: string, now: number): boolean {
  const map = windows[bucket];
  if (map.size > PRUNE_ABOVE) {
    for (const [k, w] of map) if (w.resetAt <= now) map.delete(k);
  }
  const { limit, periodMs } = LIMITS[bucket];
  const w = map.get(key);
  if (!w || w.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + periodMs });
    return false;
  }
  w.count++;
  return w.count > limit;
}

/**
 * True when `key` has gone over the bucket's limit. A missing key (no
 * CF-Connecting-IP in local dev) is never limited: refusing everyone is
 * worse than refusing nobody.
 */
export async function rateLimited(
  env: Env,
  bucket: Bucket,
  key: string | null | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!key) return false;
  const binding = env[BINDING[bucket]];
  if (binding) return !(await binding.limit({ key })).success;
  return localLimited(bucket, key, now);
}

export function tooManyRes(): Response {
  return textRes("Too many requests, retry in a minute", 429, undefined, {
    "Retry-After": "60",
  });
}

/** Test hook: forget every in-isolate window. */
export function resetRateLimits(): void {
  for (const map of Object.values(windows)) map.clear();
}
