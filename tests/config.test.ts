import { describe, it, expect } from "vitest";
import { BINDING, LIMITS, type Bucket } from "../src/rate-limit";

// Loaded without an import so the worker's tsconfig (no Node types) is happy.
const nodeProcess = (globalThis as any).process;
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const wrangler = JSON.parse(
  readFileSync(new URL("../wrangler.json", (import.meta as { url?: string }).url), "utf8"),
);

interface RateLimitConfig {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

/**
 * wrangler.json is what production runs, and nothing else reads it: every
 * other test uses the in-isolate fallbacks. These are the settings the code
 * and PRIVACY.md depend on.
 */
describe("wrangler.json", () => {
  it("enforces the limits src/rate-limit.ts documents: the binding decides alone once bound", () => {
    const configs = wrangler.ratelimits as RateLimitConfig[];
    for (const bucket of Object.keys(BINDING) as Bucket[]) {
      const config = configs.find((c) => c.name === BINDING[bucket]);
      expect(config, bucket).toBeDefined();
      expect({ bucket, limit: config!.simple.limit }).toEqual({ bucket, limit: LIMITS[bucket].limit });
      expect({ bucket, periodMs: config!.simple.period * 1000 }).toEqual({
        bucket,
        periodMs: LIMITS[bucket].periodMs,
      });
    }
    // no binding the code never reads, and one counter per binding
    expect(configs.map((c) => c.name).sort()).toEqual(Object.values(BINDING).sort());
    expect(new Set(configs.map((c) => c.namespace_id)).size).toBe(configs.length);
  });

  it("keeps per-request logs and traces off: PRIVACY.md (Server logs) promises it", () => {
    // Invocation logs would keep every URL for days: the ?login=<hash> of
    // each call and the /calendar/<token>.ics link itself.
    expect(wrangler.observability?.logs?.invocation_logs).toBe(false);
    expect(wrangler.observability?.traces?.enabled).not.toBe(true);
  });

  it("declares no cron: the empty array is what deletes the upstream schedules", () => {
    expect(wrangler.triggers?.crons).toEqual([]);
  });

  it("serves workers.dev with preview URLs off", () => {
    // Every past version keeps a preview URL bound to the live KV and D1,
    // with the code it had: rate limits, body caps and privacy fixes it
    // predates included. The extension only uses the workers.dev URL.
    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.preview_urls).toBe(false);
  });
});
