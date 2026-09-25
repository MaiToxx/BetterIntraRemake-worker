import { describe, it, expect, afterEach, vi } from "vitest";
import {
  hashLogin,
  getTokens,
  sha256Hex,
  getBearerToken,
  isOriginAllowed,
  redactPath,
  errorRes,
  isKvRateLimited,
  KV_BUSY,
  KV_RETRY,
  kvBusyRes,
  retryKvBusy,
} from "../src/utils";

describe("hashLogin", () => {
  it("produces a 64-char hex string", async () => {
    const hash = await hashLogin("nicopasla");
    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
  });

  it("is case-insensitive", async () => {
    const a = await hashLogin("NicoPasla");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("trims whitespace", async () => {
    const a = await hashLogin("  nicopasla  ");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("is deterministic", async () => {
    const a = await hashLogin("nicopasla");
    const b = await hashLogin("nicopasla");
    expect(a).toBe(b);
  });

  it("produces different hashes for different logins", async () => {
    const a = await hashLogin("alice");
    const b = await hashLogin("bob");
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("is the SHA-256 of the UTF-8 text, in lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hashLogin(" NicoPasla ")).toBe(await sha256Hex("nicopasla"));
  });
});

describe("getTokens", () => {
  it("returns sessionTokens array if present", () => {
    expect(getTokens({ sessionTokens: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("returns legacy sessionToken wrapped in array", () => {
    expect(getTokens({ sessionToken: "legacy" })).toEqual(["legacy"]);
  });

  it("returns empty array for null/undefined", () => {
    expect(getTokens(null)).toEqual([]);
    expect(getTokens(undefined)).toEqual([]);
    expect(getTokens({})).toEqual([]);
  });

  it("prefers sessionTokens over sessionToken", () => {
    expect(getTokens({ sessionTokens: ["new"], sessionToken: "old" })).toEqual(["new"]);
  });
});

describe("getBearerToken", () => {
  it("extracts Bearer token from Authorization header", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer abc123" },
    });
    expect(getBearerToken(req)).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "bearer xyz" },
    });
    expect(getBearerToken(req)).toBe("xyz");
  });

  it("returns null when no Authorization header", () => {
    const req = new Request("https://example.com");
    expect(getBearerToken(req)).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Basic abc" },
    });
    expect(getBearerToken(req)).toBeNull();
  });
});

describe("isOriginAllowed", () => {
  it("allows any intra.42.fr subdomain", () => {
    expect(isOriginAllowed("https://profile.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://profile-v3.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://meta.intra.42.fr")).toBe(true);
    expect(isOriginAllowed("https://projects.intra.42.fr")).toBe(true);
  });

  it("allows extension origins", () => {
    expect(isOriginAllowed("chrome-extension://abc123")).toBe(true);
    expect(isOriginAllowed("moz-extension://abc123")).toBe(true);
  });

  it("rejects foreign origins", () => {
    expect(isOriginAllowed("https://example.com")).toBe(false);
    expect(isOriginAllowed("https://intra.42.fr.evil.com")).toBe(false);
    expect(isOriginAllowed("https://evilintra.42.fr")).toBe(false);
    expect(isOriginAllowed("https://intra.42.fr.evil")).toBe(false);
  });
});

describe("redactPath", () => {
  it("keeps the calendar link token, login hashes and ids out of the logs", () => {
    expect(redactPath("/calendar/8f14e45f-ceea-467a-9575-6d0f5b1c2e3a.ics")).toBe("/calendar/:token.ics");
    expect(redactPath("/img/" + "ab".repeat(32) + "/avatar")).toBe("/img/:hash/avatar");
    expect(redactPath("/api/v1/private/settings")).toBe("/api/v1/private/settings");
  });
});

describe("errorRes", () => {
  it("is JSON {error, message} plus extra fields, CORS-readable, never sniffed", async () => {
    const res = errorRes("conflict", "Changed", 409, { "Retry-After": "1" }, { rev: 3 });
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toEqual({ error: "conflict", message: "Changed", rev: 3 });
  });
});

describe("retryKvBusy", () => {
  afterEach(() => {
    KV_RETRY.delayMs = 1100;
  });

  it("tells KV's per-key refusal from its other errors", () => {
    expect(isKvRateLimited(new Error("KV PUT failed: 429 Too Many Requests"))).toBe(true);
    expect(isKvRateLimited(new Error("Too many requests"))).toBe(true);
    expect(isKvRateLimited(new Error("KV put() limit exceeded for the day."))).toBe(false);
    expect(isKvRateLimited(new Error("network lost"))).toBe(false);
    expect(isKvRateLimited(new Error("id 14290 not found"))).toBe(false);
  });

  it("runs the attempt once more, marked as a retry, after a per-key refusal only", async () => {
    KV_RETRY.delayMs = 0;
    const seen: boolean[] = [];
    let n = 0;
    const out = await retryKvBusy(async (again) => {
      seen.push(again);
      if (n++ === 0) throw new Error("KV PUT failed: 429 Too Many Requests");
      return "done";
    });
    expect(out).toBe("done");
    expect(seen).toEqual([false, true]);

    await expect(
      retryKvBusy(async () => {
        throw new Error("KV put() limit exceeded for the day.");
      }),
    ).rejects.toThrow("exceeded for the day");

    const busy = await retryKvBusy(async () => {
      throw new Error("KV PUT failed: 429 Too Many Requests");
    });
    expect(busy).toBe(KV_BUSY);
  });

  it("waits KV_RETRY.delayMs between the two runs", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const pending = retryKvBusy(async () => {
        runs++;
        throw new Error("KV PUT failed: 429 Too Many Requests");
      });
      await vi.advanceTimersByTimeAsync(1099);
      expect(runs).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(KV_BUSY);
      expect(runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 503 kv_busy with Retry-After: 2 once both runs were refused", async () => {
    const res = kvBusyRes();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { error: string }).error).toBe("kv_busy");
  });
});
