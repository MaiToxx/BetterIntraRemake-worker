import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { handlePrivateSettings } from "../src/handlers/settings";
import { resetRateLimits } from "../src/rate-limit";
import {
  LEGACY_SESSION_CREATED_AT,
  SESSION_MAX_AGE_MS,
  createSession,
  legacySessionStatements,
} from "../src/sessions";
import type { Env, UserData } from "../src/types";
import {
  FakeD1,
  FakeKV,
  FakeRateLimit,
  addSession,
  makeEnv,
  tokenHash,
} from "./helpers/fake-env";

const LOGIN = "5".repeat(64);
const OTHER = "6".repeat(64);
const A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "33333333-cccc-4ccc-8ccc-cccccccccccc";

/** A student who signed in before sessions moved to D1. */
function legacyEnv(
  record: UserData = { sessionTokens: [A, B], settings: { THEME: "dark" } },
  vars: Partial<Env> = {},
) {
  return makeEnv({ kv: new FakeKV({ [LOGIN]: record }), vars });
}

/** A student whose sessions are already in D1 (see addSession). */
function d1Env(vars: Partial<Env> = {}) {
  return makeEnv({ kv: new FakeKV({ [LOGIN]: { settings: { THEME: "dark" } } }), vars });
}

function api(
  env: Env,
  path: string,
  token: string | null,
  init: RequestInit = {},
  login = LOGIN,
): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?";
  return worker.fetch(
    new Request(`https://w.test${path}${sep}login=${login}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
    }),
    env,
  );
}

const settingsOf = (env: Env, token: string | null, login = LOGIN) =>
  api(env, "/api/v1/private/settings", token, {}, login);
const signOut = (env: Env, token: string) =>
  api(env, "/api/v1/private/settings", token, { method: "DELETE" });
const sessionsOf = (env: Env, token: string | null, login = LOGIN) =>
  api(env, "/api/v1/private/sessions", token, {}, login);
const signOutOthers = (env: Env, token: string, query = "?others=true") =>
  api(env, `/api/v1/private/sessions${query}`, token, { method: "DELETE" });

function pushRequest(token: string, settings: Record<string, unknown>): Request {
  return new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

const sessionRows = (d1: FakeD1, login = LOGIN) =>
  d1.rows(
    "SELECT token_hash, created_at FROM sessions WHERE login_hash = ? ORDER BY created_at, token_hash",
    login,
  );

/** What a refusal looks like, to compare every other one with. */
async function snapshot(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].sort(),
  };
}

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("legacy sessions of the KV record", () => {
  it("are copied to D1, hashed, on the login's first request, without a KV write", async () => {
    const { env, kv, d1 } = legacyEnv();
    const res = await settingsOf(env, A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: { THEME: "dark" },
      rev: 0,
      activeSessions: 2,
      discordId: null,
    });
    expect(sessionRows(d1)).toEqual([
      { token_hash: tokenHash(A), created_at: LEGACY_SESSION_CREATED_AT },
      { token_hash: tokenHash(B), created_at: LEGACY_SESSION_CREATED_AT + 1 },
    ]);
    expect(d1.rows("SELECT login_hash FROM session_migrations")).toEqual([{ login_hash: LOGIN }]);
    // never a token in clear in D1
    const dump = JSON.stringify(d1.rows("SELECT * FROM sessions"));
    expect(dump).not.toContain(A);
    expect(dump).not.toContain(B);
    expect(kv.puts).toEqual([]);
    expect((await settingsOf(env, B)).status).toBe(200);
  });

  it("include the older single-token form", async () => {
    const { env } = legacyEnv({ sessionToken: A, settings: {} });
    expect((await settingsOf(env, A)).status).toBe(200);
  });

  it("keep the ten newest of a longer list", async () => {
    const tokens = Array.from({ length: 12 }, (_, i) => `legacy-session-${i}`);
    const { env, d1 } = legacyEnv({ sessionTokens: tokens, settings: {} });
    expect((await settingsOf(env, tokens[11])).status).toBe(200);
    expect(sessionRows(d1)).toHaveLength(10);
    expect((await settingsOf(env, tokens[0])).status).toBe(401);
    expect((await settingsOf(env, tokens[1])).status).toBe(401);
    expect((await settingsOf(env, tokens[2])).status).toBe(200);
  });

  it("are read once: after the copy, the KV list decides nothing", async () => {
    const { env, kv } = legacyEnv();
    expect((await signOut(env, A)).status).toBe(200);
    // the record still lists A, and an old worker could add a token to it
    kv.data.set(LOGIN, JSON.stringify({ sessionTokens: [A, B, C], settings: {} }));
    expect((await settingsOf(env, A)).status).toBe(401);
    expect((await settingsOf(env, C)).status).toBe(401);
    expect((await settingsOf(env, B)).status).toBe(200);
  });

  it("are not brought back by a copy that commits after the login was migrated", async () => {
    const { env, kv, d1 } = legacyEnv();
    // a request read the record and saw the login unmigrated...
    const record = kv.json(LOGIN) as UserData;
    const late = await legacySessionStatements(env, LOGIN, record);
    // ...meanwhile another one migrated it and A signed out
    expect((await signOut(env, A)).status).toBe(200);
    await d1.batch(late as never);
    expect(sessionRows(d1).map((r) => r.token_hash)).toEqual([tokenHash(B)]);
    expect((await settingsOf(env, A)).status).toBe(401);
  });

  it("refuse an unknown login without any write", async () => {
    const { env, d1 } = legacyEnv();
    const unknown = await settingsOf(env, A, OTHER);
    const wrong = await settingsOf(env, "forged-token");
    expect(await snapshot(unknown)).toEqual(await snapshot(wrong));
    expect(unknown.status).toBe(401);
    expect(d1.rows("SELECT * FROM session_migrations WHERE login_hash = ?", OTHER)).toEqual([]);
  });

  it("the stored hash is no credential", async () => {
    const { env } = legacyEnv();
    expect((await settingsOf(env, A)).status).toBe(200);
    expect((await settingsOf(env, tokenHash(A))).status).toBe(401);
  });
});

describe("session lifetime", () => {
  it("refuses a session past 365 days with the same 401 as a revoked one, on every private route", async () => {
    const { env, d1 } = d1Env();
    const now = Date.now();
    addSession(d1, LOGIN, A, now - SESSION_MAX_AGE_MS - 1);
    addSession(d1, LOGIN, B, now - SESSION_MAX_AGE_MS + 60_000);
    const ics = JSON.stringify({ ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:test\r\nEND:VCALENDAR" });
    const routes: Array<[string, RequestInit]> = [
      ["/api/v1/private/settings", {}],
      ["/api/v1/private/settings?fields=meta", {}],
      ["/api/v1/private/sessions", {}],
      ["/api/v1/private/subjects/state?slugs=libft", {}],
      ["/api/v1/private/calendar/update", { method: "POST", body: ics }],
      ["/api/v1/private/images?slot=avatar", { method: "DELETE" }],
    ];
    for (const [path, init] of routes) {
      const revoked = await snapshot(await api(env, path, "never-issued", init));
      expect(revoked.status).toBe(401);
      expect(await snapshot(await api(env, path, A, init))).toEqual(revoked);
      expect((await api(env, path, B, init)).status).toBeLessThan(300);
    }
  });

  it("gives the tokens copied from KV a year from LEGACY_SESSION_CREATED_AT", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LEGACY_SESSION_CREATED_AT + SESSION_MAX_AGE_MS - 1000);
    const { env } = legacyEnv();
    expect((await settingsOf(env, A)).status).toBe(200);
    vi.setSystemTime(LEGACY_SESSION_CREATED_AT + SESSION_MAX_AGE_MS + 1000);
    expect((await settingsOf(env, A)).status).toBe(401);
  });

  it("neither counts nor lists an expired session", async () => {
    const { env, d1 } = d1Env();
    addSession(d1, LOGIN, A, Date.now() - SESSION_MAX_AGE_MS - 1);
    addSession(d1, LOGIN, B);
    expect(await (await settingsOf(env, B)).json()).toMatchObject({ activeSessions: 1 });
    const { sessions } = (await (await sessionsOf(env, B)).json()) as { sessions: unknown[] };
    expect(sessions).toHaveLength(1);
  });
});

describe("GET /api/v1/private/sessions", () => {
  it("lists the login's sessions newest first: short id, sign-in date, the caller's marked", async () => {
    const { env, d1 } = d1Env();
    const t0 = Date.now() - 60_000;
    addSession(d1, LOGIN, A, t0);
    addSession(d1, LOGIN, B, t0 + 1000);
    addSession(d1, OTHER, C, t0 + 2000);
    const res = await sessionsOf(env, A);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      sessions: [
        { id: tokenHash(B).slice(0, 8), createdAt: t0 + 1000, current: false },
        { id: tokenHash(A).slice(0, 8), createdAt: t0, current: true },
      ],
    });
    // neither a token nor a whole hash
    for (const secret of [A, B, tokenHash(A), tokenHash(B)]) expect(text).not.toContain(secret);
  });

  it("copies a legacy login's sessions first", async () => {
    const { env } = legacyEnv();
    const { sessions } = (await (await sessionsOf(env, B)).json()) as {
      sessions: { createdAt: number; current: boolean }[];
    };
    expect(sessions).toEqual([
      { id: tokenHash(B).slice(0, 8), createdAt: LEGACY_SESSION_CREATED_AT + 1, current: true },
      { id: tokenHash(A).slice(0, 8), createdAt: LEGACY_SESSION_CREATED_AT, current: false },
    ]);
  });

  it("answers the one 401 of the private routes, before any read when there is no token", async () => {
    const { env, kv, d1 } = legacyEnv();
    const getSpy = vi.spyOn(kv, "get");
    const anonymous = await snapshot(await sessionsOf(env, null));
    expect(anonymous.status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();
    expect(d1.prepared).toEqual([]);
    expect(await snapshot(await sessionsOf(env, "forged-token"))).toEqual(anonymous);
    expect(await snapshot(await sessionsOf(env, A, OTHER))).toEqual(anonymous);
    expect(await snapshot(await settingsOf(env, "forged-token"))).toEqual(anonymous);
  });

  it("refuses the other methods", async () => {
    const { env } = legacyEnv();
    for (const method of ["POST", "PUT", "PATCH"]) {
      expect((await api(env, "/api/v1/private/sessions", A, { method })).status).toBe(405);
    }
  });
});

describe("DELETE /api/v1/private/sessions?others=true", () => {
  it("signs out every other browser of the login and keeps the caller, without a KV write", async () => {
    const { env, kv, d1 } = legacyEnv({ sessionTokens: [A, B, C], settings: {} });
    addSession(d1, OTHER, A);
    const res = await signOutOthers(env, B);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });
    expect((await settingsOf(env, A)).status).toBe(401);
    expect((await settingsOf(env, C)).status).toBe(401);
    expect((await settingsOf(env, B)).status).toBe(200);
    // another login is not touched, even with the same token
    expect(sessionRows(d1, OTHER)).toHaveLength(1);
    expect(kv.puts).toEqual([]);
    // nothing left to remove
    expect(await (await signOutOthers(env, B)).json()).toEqual({ revoked: 0 });
  });

  it("removes expired sessions without counting them", async () => {
    const { env, d1 } = d1Env();
    addSession(d1, LOGIN, A, Date.now() - SESSION_MAX_AGE_MS - 1);
    addSession(d1, LOGIN, B);
    addSession(d1, LOGIN, C);
    expect(await (await signOutOthers(env, C)).json()).toEqual({ revoked: 1 });
    expect(sessionRows(d1).map((r) => r.token_hash)).toEqual([tokenHash(C)]);
  });

  it("refuses a DELETE without others=true, and removes nothing", async () => {
    const { env, d1 } = legacyEnv();
    for (const query of ["", "?others=1", "?others=false"]) {
      const res = await signOutOthers(env, A, query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    }
    expect(sessionRows(d1)).toHaveLength(2);
  });

  it("is not rate limited, like the sign-out", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env } = legacyEnv(undefined, { WRITE_RL: rl });
    expect((await signOutOthers(env, A)).status).toBe(200);
  });
});

describe("sessions and settings no longer share one write", () => {
  it("a push that read the record before a sign-in does not drop the new session", async () => {
    const { env, kv } = legacyEnv();
    expect((await settingsOf(env, A)).status).toBe(200);
    const readByPush = kv.json(LOGIN) as UserData;
    const { token } = await createSession(env, LOGIN, readByPush);
    const res = await handlePrivateSettings(pushRequest(A, { THEME: "light" }), env, LOGIN, readByPush);
    expect(res.status).toBe(200);
    expect((await settingsOf(env, token)).status).toBe(200);
    // the push stored the settings alone: no token in clear any more
    expect(kv.json(LOGIN)).toEqual({ settings: { THEME: "light" }, settingsRev: expect.any(Number) });
  });

  it("a push racing a sign-out does not bring the removed token back", async () => {
    const { env, kv } = legacyEnv();
    expect((await settingsOf(env, B)).status).toBe(200);
    const readByPush = kv.json(LOGIN) as UserData;
    expect((await signOut(env, A)).status).toBe(200);
    const res = await handlePrivateSettings(pushRequest(B, { THEME: "light" }), env, LOGIN, readByPush);
    expect(res.status).toBe(200);
    expect((await settingsOf(env, A)).status).toBe(401);
  });

  it("a sign-in that read an old copy of the record does not roll the settings back", async () => {
    const { env, kv } = legacyEnv({ sessionTokens: [A], settings: { THEME: "old" } });
    const readBySignIn = kv.json(LOGIN) as UserData;
    const res = await handlePrivateSettings(pushRequest(A, { THEME: "new" }), env, LOGIN, readBySignIn);
    expect(res.status).toBe(200);
    await createSession(env, LOGIN, readBySignIn);
    expect(kv.json(LOGIN)).toEqual({ settings: { THEME: "new" }, settingsRev: expect.any(Number) });
  });

  it("a sign-in next to a live session does not take a missing record for a first one", async () => {
    const { env, d1 } = d1Env();
    expect((await createSession(env, OTHER, null)).first).toBe(true);
    addSession(d1, LOGIN, A);
    expect((await createSession(env, LOGIN, null)).first).toBe(false);
  });
});

describe("routes that need the session only", () => {
  it("read no KV record once the login is migrated", async () => {
    const { env, kv } = legacyEnv();
    expect((await settingsOf(env, A)).status).toBe(200);
    const getSpy = vi.spyOn(kv, "get");
    const ics = JSON.stringify({ ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:test\r\nEND:VCALENDAR" });
    for (const [path, init] of [
      ["/api/v1/private/sessions", {}],
      ["/api/v1/private/calendar/token", {}],
      ["/api/v1/private/subjects/state?slugs=libft", {}],
      ["/api/v1/private/calendar/update", { method: "POST", body: ics }],
      ["/api/v1/private/images?slot=avatar", { method: "DELETE" }],
    ] as Array<[string, RequestInit]>) {
      expect((await api(env, path, A, init)).status).toBeLessThan(300);
    }
    expect(getSpy).not.toHaveBeenCalled();
    // the full settings read still reads it, once, and so does the account
    // card's meta read: the settings revision lives in the record
    expect((await settingsOf(env, A)).status).toBe(200);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect((await api(env, "/api/v1/private/settings?fields=meta", A)).status).toBe(200);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
