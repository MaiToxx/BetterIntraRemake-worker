import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { FakeKV, makeEnv } from "./helpers/fake-env";

const LOGIN = "d".repeat(64);
const OTHER = "e".repeat(64);
const SESSION = "session-d";

function seeded(vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({
      [LOGIN]: { sessionTokens: [SESSION], settings: { A: 1 } },
    }),
    vars,
  });
}

describe("catch-all error handler", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns an exception into a JSON 500 the extension can read", async () => {
    const { env, kv } = seeded();
    kv.putError = new Error("KV put() limit exceeded for the day.");
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SESSION}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings: { A: 2 } }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "server_error",
      message: "KV put() limit exceeded for the day.",
    });
  });

  it("logs the method and path of the failed route, never the query string", async () => {
    const { env, kv } = seeded();
    kv.putError = new Error("KV put() limit exceeded for the day.");
    await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SESSION}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings: { A: 2 } }),
      }),
      env,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("POST /api/v1/private/settings");
    expect(line).toContain("KV put() limit exceeded");
    expect(line).not.toContain(LOGIN);
    expect(line).not.toContain("?");
  });

  it("never puts a stack trace or a configured secret in the body", async () => {
    const secret = "s3cr3t-announcement-value";
    const { env, kv } = seeded({ ANNOUNCEMENT_SECRET: secret });
    kv.get = async () => {
      throw new Error(`upstream said ${secret}`);
    };
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
    expect(text).not.toMatch(/\bat .*\.ts/);
  });

  it("keeps normal responses untouched", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("CORS preflight", () => {
  it("lets the browser cache the answer for a day", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://profile-v3.intra.42.fr",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://profile-v3.intra.42.fr",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });

  it("still refuses a foreign origin", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("login parameter", () => {
  it("only accepts a login hash, so internal KV keys stay out of reach", async () => {
    const { env, kv } = seeded();
    kv.data.set("INTRA_JWKS_CACHE", "[]");
    kv.data.set("CALENDAR_TOKEN_abcdefgh", LOGIN);
    const getSpy = vi.spyOn(kv, "get");
    for (const login of [
      "ANNOUNCEMENT",
      "CALENDAR_TOKEN_abcdefgh",
      "INTRA_JWKS_CACHE",
      LOGIN.toUpperCase(),
      "x".repeat(600),
    ]) {
      const res = await worker.fetch(
        new Request(
          `https://w.test/api/v1/public/visuals?login=${encodeURIComponent(login)}`,
        ),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("private routes without a Bearer token", () => {
  it("answer 401 before the KV read, identical to a wrong token or an unknown login", async () => {
    const { env, kv } = seeded();
    const getSpy = vi.spyOn(kv, "get");
    const anonymous = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`),
      env,
    );
    expect(anonymous.status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();

    const wrongToken = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        headers: { Authorization: "Bearer forged" },
      }),
      env,
    );
    const unknownLogin = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${OTHER}`, {
        headers: { Authorization: "Bearer forged" },
      }),
      env,
    );
    const bodies = await Promise.all(
      [anonymous, wrongToken, unknownLogin].map(async (r) => ({
        status: r.status,
        body: await r.text(),
        headers: [...r.headers.entries()].sort(),
      })),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});

describe("batch public visuals", () => {
  it("answers every requested hash from one bulk read, unknown ones with the defaults", async () => {
    const { env, kv } = seeded();
    kv.data.set(
      OTHER,
      JSON.stringify({
        sessionTokens: ["s"],
        settings: { PROFILE_IMAGE_URL: "https://img.test/e.png" },
      }),
    );
    const getSpy = vi.spyOn(kv, "get");
    const unknown = "f".repeat(64);
    const res = await worker.fetch(
      new Request(
        `https://w.test/api/v1/public/visuals?logins=${LOGIN},${OTHER},${unknown},${OTHER}`,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toEqual([LOGIN, OTHER, unknown]);
    const { visuals } = (await res.json()) as {
      visuals: Record<string, { avatar: string; avatarBg: string }>;
    };
    expect(Object.keys(visuals).sort()).toEqual([LOGIN, OTHER, unknown].sort());
    expect(visuals[OTHER].avatar).toBe("https://img.test/e.png");
    expect(visuals[LOGIN].avatar).toBe("");
    expect(visuals[unknown]).toEqual(visuals[LOGIN]);
    expect(visuals[unknown].avatarBg).toBe("transparent");
  });

  it("refuses more than 50 hashes or a value that is not a hash, without a KV read", async () => {
    const { env, kv } = seeded();
    const getSpy = vi.spyOn(kv, "get");
    const many = Array.from({ length: 51 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ).join(",");
    for (const logins of [many, `${LOGIN},INTRA_JWKS_CACHE`, "", ",,"]) {
      const res = await worker.fetch(
        new Request(
          `https://w.test/api/v1/public/visuals?logins=${encodeURIComponent(logins)}`,
        ),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(getSpy).not.toHaveBeenCalled();
    const fifty = Array.from({ length: 50 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ).join(",");
    expect(
      (
        await worker.fetch(
          new Request(`https://w.test/api/v1/public/visuals?logins=${fifty}`),
          env,
        )
      ).status,
    ).toBe(200);
  });

  it("keeps the single-login form for older builds", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(((await res.json()) as { avatar: string }).avatar).toBe("");
  });
});

/**
 * Routes of the upstream worker that need a 42 application, Discord or R2.
 * They are gone from this deployment: a 404 with no KV, D1 or network work,
 * whatever the credentials.
 */
describe("removed routes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const auth = { Authorization: `Bearer ${SESSION}` };
  const cases: Array<[string, RequestInit]> = [
    ["/login?redirect_uri=https://profile-v3.intra.42.fr/", {}],
    ["/callback?code=x&state=https://profile-v3.intra.42.fr/", {}],
    ["/discord/auth?token=x&login=y", {}],
    ["/discord/callback?code=abc&state=made-up", {}],
    [`/api/v1/private/discord/link?login=${LOGIN}`, { method: "POST", headers: auth }],
    [`/api/v1/private/discord/test`, { method: "POST" }],
    ["/api/v1/public/images/0123abcd-0000-4000-8000-000000000000", {}],
    [`/api/v1/private/image-upload?login=${LOGIN}`, { method: "POST", headers: auth }],
    [`/api/v1/students?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/pisciners?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/piscines?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/future-students?login=${LOGIN}`, { headers: auth }],
    ["/api/v1/students/refresh", { method: "POST" }],
    ["/api/v1/future-students/refresh", { method: "POST" }],
    [`/api/v1/private/logtime/history?login=${LOGIN}&user=x`, { headers: auth }],
    [`/api/v1/private/friends/data?login=${LOGIN}&logins=a`, { headers: auth }],
    [`/api/v1/private/profile-stats?login=${LOGIN}&target=x`, { headers: auth }],
    [`/api/v1/private/evaluations?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/private/outstanding?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/private/proxy?login=${LOGIN}&path=/v2/me`, { headers: auth }],
    ["/api/v1/private/projects/refresh", { method: "POST", body: "{}" }],
  ];

  for (const [path, init] of cases) {
    it(`${init.method ?? "GET"} ${path.split("?")[0]} is gone`, async () => {
      const { env, kv, d1 } = seeded();
      const puts = kv.puts.length;
      const res = await worker.fetch(new Request(`https://w.test${path}`, init), env);
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(kv.puts.length).toBe(puts);
      expect(kv.deletes).toEqual([]);
      expect(d1.prepared).toEqual([]);
    });
  }

  it("has no scheduled handler any more", () => {
    expect((worker as { scheduled?: unknown }).scheduled).toBeUndefined();
  });
});
