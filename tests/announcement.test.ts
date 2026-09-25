import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ANNOUNCEMENT_CACHE_MS,
  handleAnnouncement,
  MAX_ANNOUNCEMENT_BODY_BYTES,
  resetAnnouncementCache,
} from "../src/handlers/announcement";
import { LIMITS, resetRateLimits } from "../src/rate-limit";
import { FakeKV, FakeRateLimit, makeEnv } from "./helpers/fake-env";

// The banner memo and the admin bucket live in the module, shared by every
// case of this file: each case starts from an empty isolate.
beforeEach(() => {
  resetAnnouncementCache();
  resetRateLimits();
});

const SECRET = "announce-secret-123";
const URL = "https://w.test/api/v1/public/announcement";

function setup(
  withBanner = true,
  vars: { ANNOUNCEMENT_SECRET?: string } = { ANNOUNCEMENT_SECRET: SECRET },
) {
  const seed = withBanner
    ? {
        ANNOUNCEMENT: {
          message: "Maintenance tonight",
          updatedAt: 1,
          level: "warning",
          links: [],
        },
      }
    : {};
  return makeEnv({ kv: new FakeKV(seed), vars });
}

const post = (body: unknown) =>
  new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("announcement", () => {
  it("serves the banner to everyone", async () => {
    const { env } = setup();
    const res = await handleAnnouncement(new Request(URL), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      message: "Maintenance tonight",
      updatedAt: 1,
      level: "warning",
      links: [],
    });
  });

  it("sets a banner with the secret in the body, normalising level and links", async () => {
    const { env, kv } = setup(false);
    const res = await handleAnnouncement(
      post({
        secret: SECRET,
        message: "  Hello  ",
        level: "loud",
        links: [
          { text: "Docs", url: "https://docs.test" },
          { text: "bad", url: "javascript:1" },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(kv.json("ANNOUNCEMENT")).toMatchObject({
      message: "Hello",
      level: "critical",
      links: [{ text: "Docs", url: "https://docs.test" }],
    });
  });

  it("clears the banner with an empty message", async () => {
    const { env, kv } = setup();
    const res = await handleAnnouncement(post({ secret: SECRET, message: "" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: null });
    expect(kv.deletes).toEqual(["ANNOUNCEMENT"]);
  });

  it("refuses a wrong or missing secret, and everything when none is configured", async () => {
    const { env, kv } = setup();
    expect((await handleAnnouncement(post({ secret: "nope", message: "x" }), env)).status).toBe(403);
    expect((await handleAnnouncement(post({ message: "x" }), env)).status).toBe(403);
    const unset = setup(true, {});
    expect((await handleAnnouncement(post({ secret: "", message: "" }), unset.env)).status).toBe(403);
    expect((await handleAnnouncement(post({ message: "" }), unset.env)).status).toBe(403);
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(unset.kv.deletes).toEqual([]);
  });

  it("no longer takes the secret from the query string: DELETE is not a method here", async () => {
    const { env, kv } = setup();
    const res = await handleAnnouncement(
      new Request(`${URL}?secret=${SECRET}`, { method: "DELETE" }),
      env,
    );
    expect(res.status).toBe(405);
    expect(kv.deletes).toEqual([]);
    expect(kv.json("ANNOUNCEMENT").message).toBe("Maintenance tonight");
  });
});

describe("announcement POST body cap", () => {
  it("refuses a body past the cap with 413, before the secret check and any write", async () => {
    const { env, kv } = setup();
    const huge = "x".repeat(MAX_ANNOUNCEMENT_BODY_BYTES);
    for (const secret of [SECRET, "wrong"]) {
      const res = await handleAnnouncement(post({ secret, message: "", padding: huge }), env);
      expect(res.status).toBe(413);
    }
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(kv.json("ANNOUNCEMENT").message).toBe("Maintenance tonight");
  });

  it("still takes the largest real announcement", async () => {
    const { env, kv } = setup(false);
    const links = Array.from({ length: 5 }, (_, i) => ({
      text: `Link ${i} `.padEnd(100, "t"),
      url: `https://docs.test/${"p".repeat(1000)}${i}`,
    }));
    const message = "é".repeat(500);
    const res = await handleAnnouncement(
      post({ secret: SECRET, message, level: "info", links }),
      env,
    );
    expect(res.status).toBe(200);
    expect(kv.json("ANNOUNCEMENT")).toMatchObject({ message, links });
  });

  it("answers 400 for a body that is not JSON and 403 for one that is not an object", async () => {
    const { env, kv } = setup();
    const raw = (body: string) => new Request(URL, { method: "POST", body });
    expect((await handleAnnouncement(raw("{"), env)).status).toBe(400);
    expect((await handleAnnouncement(raw("null"), env)).status).toBe(403);
    expect(kv.puts).toEqual([]);
  });
});

describe("announcement memo", () => {
  const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
  const get = (env: ReturnType<typeof setup>["env"], now: number) =>
    handleAnnouncement(new Request(URL), env, now);

  it("reads KV once per isolate while the memo is fresh, the empty answer included", async () => {
    for (const withBanner of [true, false]) {
      resetAnnouncementCache();
      const { env, kv } = setup(withBanner);
      const getSpy = vi.spyOn(kv, "get");
      const first = await (await get(env, T0)).json();
      const second = await (await get(env, T0 + ANNOUNCEMENT_CACHE_MS - 1)).json();
      expect(second).toEqual(first);
      expect(getSpy).toHaveBeenCalledTimes(1);
      if (!withBanner) {
        expect(first).toEqual({ message: null, updatedAt: null, level: "critical", links: [] });
      }
    }
  });

  it("reads again once the memo is ANNOUNCEMENT_CACHE_MS old", async () => {
    const { env, kv } = setup();
    const getSpy = vi.spyOn(kv, "get");
    await get(env, T0);
    kv.data.set("ANNOUNCEMENT", JSON.stringify({ message: "Back online", updatedAt: 2, level: "info", links: [] }));
    expect(((await (await get(env, T0 + 1000)).json()) as { message: string }).message).toBe("Maintenance tonight");
    const later = await get(env, T0 + ANNOUNCEMENT_CACHE_MS);
    expect(((await later.json()) as { message: string }).message).toBe("Back online");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("serves what a POST set or cleared at once in its isolate, without a read", async () => {
    const { env, kv } = setup();
    await get(env, T0); // memo holds the old banner
    const getSpy = vi.spyOn(kv, "get");
    const banner = {
      secret: SECRET,
      message: "New banner",
      level: "info",
      links: [{ text: "Docs", url: "https://docs.test" }],
    };
    const set = await handleAnnouncement(post(banner), env, T0 + 10);
    expect(set.status).toBe(200);
    const fromPost = await (await get(env, T0 + 20)).text();
    expect(JSON.parse(fromPost)).toEqual({
      message: "New banner",
      updatedAt: T0 + 10,
      level: "info",
      links: [{ text: "Docs", url: "https://docs.test" }],
    });
    expect(getSpy).not.toHaveBeenCalled();
    // byte for byte what a read of the stored value answers
    resetAnnouncementCache();
    expect(await (await get(env, T0 + 30)).text()).toBe(fromPost);

    getSpy.mockClear();
    await handleAnnouncement(post({ secret: SECRET, message: "" }), env, T0 + 50);
    expect(await (await get(env, T0 + 60)).json()).toEqual({
      message: null,
      updatedAt: null,
      level: "critical",
      links: [],
    });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("never keeps a KV error: the next GET reads again", async () => {
    const { env, kv } = setup();
    const real = kv.get.bind(kv);
    let fail = true;
    kv.get = (async (...args: Parameters<FakeKV["get"]>) => {
      if (fail) throw new Error("KV get failed");
      return real(...args);
    }) as FakeKV["get"];
    await expect(get(env, T0)).rejects.toThrow("KV get failed");
    fail = false;
    expect(((await (await get(env, T0 + 1)).json()) as { message: string }).message).toBe("Maintenance tonight");
  });
});

describe("announcement POST limit and secret check", () => {
  const postFrom = (ip: string | null, body: unknown) =>
    new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(ip ? { "CF-Connecting-IP": ip } : {}) },
      body: JSON.stringify(body),
    });

  it("refuses the 6th POST a minute from one address with 429, before the body and any KV call", async () => {
    const { env, kv } = setup();
    const getSpy = vi.spyOn(kv, "get");
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.admin.limit + 1; i++) {
      statuses.push((await handleAnnouncement(postFrom("203.0.113.7", { secret: `guess-${i}`, message: "x" }), env)).status);
    }
    expect(LIMITS.admin.limit).toBe(5);
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
    // even the right secret waits out the window: the limit is per address
    const limited = await handleAnnouncement(postFrom("203.0.113.7", { secret: SECRET, message: "x" }), env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
    // a body past the cap is not even read once limited
    const huge = await handleAnnouncement(
      postFrom("203.0.113.7", { secret: SECRET, padding: "x".repeat(MAX_ANNOUNCEMENT_BODY_BYTES) }),
      env,
    );
    expect(huge.status).toBe(429);
    expect(getSpy).not.toHaveBeenCalled();
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    // another address is not affected, and the right secret works there
    const other = await handleAnnouncement(postFrom("198.51.100.4", { secret: SECRET, message: "Hi" }), env);
    expect(other.status).toBe(200);
  });

  it("keys IPv6 by /64, so one host cannot rotate addresses past the limit", async () => {
    const { env } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.admin.limit + 1; i++) {
      statuses.push((await handleAnnouncement(postFrom(`2a01:cb10:793:3f00::${i + 1}`, { secret: "nope", message: "x" }), env)).status);
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it("uses the ADMIN_RL binding when bound, keyed like the fallback", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env, kv } = setup(true, { ANNOUNCEMENT_SECRET: SECRET });
    (env as { ADMIN_RL?: FakeRateLimit }).ADMIN_RL = rl;
    const res = await handleAnnouncement(postFrom("2001:db8:1:2:3:4:5:6", { secret: SECRET, message: "x" }), env);
    expect(res.status).toBe(429);
    expect(rl.calls).toEqual(["2001:db8:1:2::/64"]);
    expect(kv.puts).toEqual([]);
  });

  it("never limits a POST without a client address (local dev), nor any GET", async () => {
    const { env } = setup();
    for (let i = 0; i < LIMITS.admin.limit + 3; i++) {
      expect((await handleAnnouncement(postFrom(null, { secret: "nope", message: "x" }), env)).status).toBe(403);
    }
    for (let i = 0; i < LIMITS.admin.limit + 3; i++) {
      const res = await handleAnnouncement(
        new Request(URL, { headers: { "CF-Connecting-IP": "203.0.113.7" } }),
        env,
      );
      expect(res.status).toBe(200);
    }
  });

  it("answers an unset secret with 403 before reading the body", async () => {
    const { env, kv } = setup(true, {});
    const huge = await handleAnnouncement(
      postFrom("203.0.113.7", { secret: "", padding: "x".repeat(MAX_ANNOUNCEMENT_BODY_BYTES) }),
      env,
    );
    expect(huge.status).toBe(403);
    expect(kv.puts).toEqual([]);
  });

  it("takes only the exact secret: a prefix, a longer string or another case is refused", async () => {
    const { env, kv } = setup(false);
    for (const secret of [SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), ` ${SECRET}`]) {
      expect((await handleAnnouncement(post({ secret, message: "x" }), env)).status).toBe(403);
    }
    expect(kv.puts).toEqual([]);
    expect((await handleAnnouncement(post({ secret: SECRET, message: "x" }), env)).status).toBe(200);
    expect(kv.puts).toEqual(["ANNOUNCEMENT"]);
  });
});
