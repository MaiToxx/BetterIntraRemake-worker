import { describe, it, expect, beforeEach } from "vitest";
import {
  LIMITS,
  clientKey,
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
    expect(await res.json()).toEqual({
      error: "rate_limited",
      message: expect.stringMatching(/retry/i),
    });
  });
});

describe("clientKey", () => {
  it("keys an IPv6 address by its /64, whatever its spelling", () => {
    const key = "2a01:cb10:793:3f00::/64";
    for (const ip of [
      "2a01:cb10:793:3f00::1",
      "2a01:cb10:793:3f00::2",
      "2A01:CB10:0793:3F00:AAAA:BBBB:CCCC:DDDD",
      "2a01:cb10:793:3f00:0:0:0:1",
    ]) {
      expect(clientKey(ip)).toBe(key);
    }
    expect(clientKey("2a01:cb10:793:3f01::1")).toBe("2a01:cb10:793:3f01::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(clientKey("fe80::1:2:3:4")).toBe("fe80:0:0:0::/64");
  });

  it("keeps IPv4 as is, unwraps IPv4-mapped addresses, and never throws on garbage", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey(null)).toBeNull();
    expect(clientKey(undefined)).toBeNull();
    expect(clientKey("")).toBeNull();
    for (const odd of ["1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4::5:6:7:8", "12345::1", "zz::1", "64:ff9b::192.0.2.1"]) {
      expect(clientKey(odd)).toBe(odd);
    }
  });

  it("gives one window to a host rotating addresses inside its /64", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < LIMITS.visuals.limit; i++) {
      expect(await rateLimited(env, "visuals", clientKey(`2a01:cb10:793:3f00::${(i + 1).toString(16)}`))).toBe(false);
    }
    expect(await rateLimited(env, "visuals", clientKey("2a01:cb10:793:3f00:ffff::9"))).toBe(true);
    expect(await rateLimited(env, "visuals", clientKey("2a01:cb10:793:3f01::1"))).toBe(false);
  });
});
