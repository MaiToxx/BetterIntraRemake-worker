export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  better_intra_d1: D1Database;
  /**
   * Workers rate limit bindings (wrangler.json "ratelimits"). Optional: a
   * deployment or a test without them falls back to the in-isolate buckets of
   * src/rate-limit.ts.
   */
  WRITE_RL?: RateLimit;
  ANON_RL?: RateLimit;
  ANNOUNCEMENT_SECRET?: string;
}

export type UserData = {
  sessionTokens?: string[];
  sessionToken?: string; // legacy
  settings?: Record<string, unknown>;
};
