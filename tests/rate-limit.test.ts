import { describe, it, expect, beforeEach } from "vitest";
import {
  LIMITS,
  rateLimited,
  resetRateLimits,
  tooManyRes,
} from "../src/rate-limit";
import { FakeRateLimit, makeEnv } from "./helpers/fake-env";

beforeEach(() => {
  resetRateLimits();
});

describe("in-isolate fallback", () => {
  it("refuses past the limit, per bucket and per key, and forgets after the window", async () => {
    const { env } = makeEnv();
    const t0 = 1_000_000;
    for (let i = 0; i < LIMITS.write.limit; i++) {
      expect(await rateLimited(env, "write", "alice", t0 + i)).toBe(false);
    }
    expect(await rateLimited(env, "write", "alice", t0 + 50)).toBe(true);
    // other key, other bucket: untouched
    expect(await rateLimited(env, "write", "bob", t0 + 50)).toBe(false);
    expect(await rateLimited(env, "anon", "alice", t0 + 50)).toBe(false);
    // the window is one minute from the first call
    expect(
      await rateLimited(env, "write", "alice", t0 + LIMITS.write.periodMs - 1),
    ).toBe(true);
    expect(
      await rateLimited(env, "write", "alice", t0 + LIMITS.write.periodMs),
    ).toBe(false);
  });

  it("never limits a missing key", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < LIMITS.anon.limit + 10; i++) {
      expect(await rateLimited(env, "anon", null)).toBe(false);
      expect(await rateLimited(env, "anon", undefined)).toBe(false);
    }
  });

  it("keeps its memory bounded by pruning expired windows", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 6_000; i++) await rateLimited(env, "anon", `ip-${i}`, 0);
    const later = LIMITS.anon.periodMs + 1;
    expect(await rateLimited(env, "anon", "alice", later)).toBe(false);
    for (let i = 0; i < 6_000; i++) {
      expect(await rateLimited(env, "anon", `ip-${i}`, later + 1)).toBe(false);
    }
  });
});

describe("Workers binding", () => {
  it("is preferred over the fallback and decides alone", async () => {
    const write = new FakeRateLimit(2);
    const anon = new FakeRateLimit();
    anon.denyAll = true;
    const { env } = makeEnv({ vars: { WRITE_RL: write, ANON_RL: anon } });
    expect(await rateLimited(env, "write", "alice")).toBe(false);
    expect(await rateLimited(env, "write", "alice")).toBe(false);
    expect(await rateLimited(env, "write", "alice")).toBe(true);
    expect(write.calls).toEqual(["alice", "alice", "alice"]);
    expect(await rateLimited(env, "anon", "1.2.3.4")).toBe(true);
    expect(anon.calls).toEqual(["1.2.3.4"]);
  });
});

describe("tooManyRes", () => {
  it("is a CORS-readable 429 with Retry-After", async () => {
    const res = tooManyRes();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toMatch(/retry/i);
  });
});
