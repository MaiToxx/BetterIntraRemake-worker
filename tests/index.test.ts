import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { getAppToken, has42App } from "../src/utils";
import type { Env } from "../src/types";
import { FakeD1, FakeKV, makeEnv } from "./helpers/fake-env";

const LOGIN = "d".repeat(64);
const SESSION = "session-d";
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function seeded(vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({
      [LOGIN]: { sessionTokens: [SESSION], settings: { A: 1 } },
    }),
    vars,
  });
}

describe("catch-all error handler", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("never puts a stack trace or a configured secret in the body", async () => {
    const secret = "s3cr3t-client-secret-value";
    const { env, kv } = seeded({
      CLIENT_SECRET: secret,
      PROXY_SECRET: "proxy-key-123",
    });
    kv.get = async () => {
      throw new Error(`upstream said ${secret} and proxy-key-123`);
    };
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("proxy-key-123");
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
  });
});

describe("login parameter", () => {
  it("only accepts a login hash, so internal KV keys stay out of reach", async () => {
    const { env, kv } = seeded();
    kv.data.set(
      "APP_TOKEN_CACHE",
      JSON.stringify({ token: "app", expires: 0 }),
    );
    kv.data.set("CALENDAR_TOKEN_abcdefgh", LOGIN);
    const getSpy = vi.spyOn(kv, "get");
    for (const login of [
      "APP_TOKEN_CACHE",
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

describe("crons without a 42 application", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skip cleanly while CLIENT_ID is the placeholder", async () => {
    const { env, d1, kv } = makeEnv({
      vars: { CLIENT_ID: "TO_FILL_42_APP_UID", CLIENT_SECRET: "x" },
    });
    const getSpy = vi.spyOn(kv, "get");
    for (const cron of ["*/10 * * * *", "* * * * *", "0 22,4,10,16 * * *"]) {
      await expect(
        worker.scheduled(
          { cron, scheduledTime: Date.now() } as ScheduledEvent,
          env,
          ctx,
        ),
      ).resolves.toBeUndefined();
    }
    expect(d1.prepared).toEqual([]);
    expect(getSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still run on a deployment that has one", async () => {
    const d1 = new FakeD1();
    const { env } = makeEnv({
      d1,
      vars: { CLIENT_ID: "u-s4t2ud-real", CLIENT_SECRET: "s-real" },
    });
    await worker.scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env,
      ctx,
    );
    expect(d1.prepared.some((sql) => sql.includes("evals_enabled = 1"))).toBe(
      true,
    );
  });

  it("has42App needs a real CLIENT_ID and a secret", () => {
    expect(
      has42App({ CLIENT_ID: "TO_FILL_42_APP_UID", CLIENT_SECRET: "s" }),
    ).toBe(false);
    expect(has42App({ CLIENT_ID: "u-s4t2ud-real", CLIENT_SECRET: "" })).toBe(
      false,
    );
    expect(has42App({ CLIENT_ID: "", CLIENT_SECRET: "s" })).toBe(false);
    expect(has42App({ CLIENT_ID: "u-s4t2ud-real", CLIENT_SECRET: "s" })).toBe(
      true,
    );
  });

  it("getAppToken fails fast, without a KV read or a request", async () => {
    const { env, kv } = makeEnv();
    const getSpy = vi.spyOn(kv, "get");
    await expect(getAppToken(env)).rejects.toThrow(/42 application/);
    expect(getSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Discord OAuth callback", () => {
  it("spends no KV delete on a made-up state", async () => {
    const { env, kv } = makeEnv();
    const res = await worker.fetch(
      new Request("https://w.test/discord/callback?code=abc&state=made-up"),
      env,
    );
    expect(res.status).toBe(400);
    expect(kv.deletes).toEqual([]);
  });
});
