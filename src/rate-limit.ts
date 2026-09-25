import { Env } from "./types";
import { errorRes } from "./utils";

/**
 * Four buckets, all over one minute:
 *
 *  - "write", keyed by login hash: every route that writes the user's data
 *    (sign-in once the token is verified, settings push, wipe, calendar
 *    link, stop and upload, images, subject reports). The KV namespace
 *    shares 1,000 writes a day on the free plan and past the limit every put
 *    throws for everyone until midnight UTC, so one client replaying its
 *    own valid token, or pushing distinct payloads in a loop, must stay
 *    slow. 10 a minute is far above any real use (sign-in is a click, a
 *    push is a hub action).
 *  - "anon", keyed by client IP (IPv6: by /64, see clientKey): the
 *    unauthenticated /auth/intra before any JWKS work, so garbage POSTs
 *    cannot make the worker hammer auth.42.fr. A campus sits behind one NAT,
 *    hence the higher limit.
 *  - "visuals", keyed by client IP (same): the anonymous batch visuals route, which
 *    reads up to 50 KV keys per call (missing keys are billed too). Without
 *    it, about 2,000 calls with made-up hashes spend the 100,000 daily KV
 *    reads and every route answers 500 until midnight UTC. A student sends
 *    at most one batch per friends list every 10 minutes (the extension's
 *    cache), so 120 a minute leaves a whole campus NAT far below the limit
 *    while one address needs more than a quarter of an hour to drain the
 *    reads. The single-login routes stay unlimited: one read per call is
 *    the same ratio as the 100,000 daily Worker requests.
 *  - "admin", keyed by client IP (same): the announcement POST, the one
 *    route that takes the operator's secret. 5 a minute is plenty for a
 *    person posting a banner and turns guessing into a crawl; a bucket of its
 *    own so that a guessing loop behind a campus NAT does not lock everyone
 *    there out of /auth/intra.
 *
 * None of them makes the daily budget unexhaustible: they make abuse slow and
 * attributable. The Workers rate limit bindings (wrangler.json "ratelimits")
 * are used when bound; without them (local dev, tests, a fork that did not
 * add them) a fixed window per isolate stands in. Both are best effort per
 * colo or per isolate, never a global counter.
 */
export type Bucket = "write" | "anon" | "visuals" | "admin";

export const LIMITS: Record<Bucket, { limit: number; periodMs: number }> = {
  write: { limit: 10, periodMs: 60_000 },
  anon: { limit: 30, periodMs: 60_000 },
  visuals: { limit: 120, periodMs: 60_000 },
  admin: { limit: 5, periodMs: 60_000 },
};

/**
 * The binding of each bucket. Production enforces the limits written in
 * wrangler.json "ratelimits" under these names, not LIMITS (the fallback):
 * tests/config.test.ts fails when the two disagree.
 */
export const BINDING: Record<
  Bucket,
  keyof Pick<Env, "WRITE_RL" | "ANON_RL" | "VISUALS_RL" | "ADMIN_RL">
> = {
  write: "WRITE_RL",
  anon: "ANON_RL",
  visuals: "VISUALS_RL",
  admin: "ADMIN_RL",
};

interface Window {
  count: number;
  resetAt: number;
}

const windows: Record<Bucket, Map<string, Window>> = {
  write: new Map(),
  anon: new Map(),
  visuals: new Map(),
  admin: new Map(),
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

/**
 * Key of a client address for the per-IP buckets ("anon", "visuals", "admin"). One
 * IPv6 host holds a whole /64 (a home line or a cloud VM gets at least that)
 * and can take a new source address for every request, so keying on the full
 * address let one machine walk past both limits: an IPv6 address is keyed by
 * its /64 prefix, written in one canonical form whatever the input's
 * compression or case (`2a01:cb10:793:3f00::/64`). An IPv4-mapped address
 * counts as the IPv4 address it carries; IPv4, and anything that does not
 * parse (Cloudflare sets this header, so that is not expected), is kept as
 * is.
 */
export function clientKey(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (!ip.includes(":")) return ip;
  const lower = ip.trim().toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const halves = lower.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    // "::" stands for one group of zeros at least
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return ip;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    return ip;
  }
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

export function tooManyRes(): Response {
  return errorRes("rate_limited", "Too many requests, retry in a minute", 429, {
    "Retry-After": "60",
  });
}

/** Test hook: forget every in-isolate window. */
export function resetRateLimits(): void {
  for (const map of Object.values(windows)) map.clear();
}
