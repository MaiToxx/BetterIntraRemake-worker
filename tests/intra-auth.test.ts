import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  INTRA_ISSUER,
  JWKS_REFRESH_MIN_INTERVAL_MS,
  MAX_AUTH_BODY_BYTES,
  azpAllowed,
  handleIntraAuth,
  resetJwksRefreshThrottle,
  verifyIntraJwt,
  type Jwk,
} from "../src/handlers/intra-auth";
import worker from "../src/index";
import type { Env } from "../src/types";
import { LIMITS, resetRateLimits } from "../src/rate-limit";
import {
  LEGACY_SESSION_CREATED_AT,
  MAX_SESSIONS,
  SESSION_MAX_AGE_MS,
} from "../src/sessions";
import { FETCH_DEADLINES, hashLogin, KV_RETRY } from "../src/utils";
import { BUDGET_ALL, DAILY_KV_WRITES_SIGN_IN, utcDay } from "../src/budget";
import { FakeD1, FakeRateLimit, addSession, hangingFetch, stalledBody, tokenHash } from "./helpers/fake-env";

// Node 20+ exposes WebCrypto globally, like the Workers runtime does.
const subtle = crypto.subtle;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let jwks: Jwk[];
let otherJwks: Jwk[];

async function makeKey(kid: string) {
  const pair = (await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n: pub.n!, e: pub.e! } as Jwk };
}

async function sign(payload: Record<string, unknown>, key: CryptoKey, kid = "k1", alg = "RS256") {
  const header = b64url(JSON.stringify({ alg, typ: "JWT", kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

const now = 1_800_000_000_000; // fixed "now" in ms
const validPayload = () => ({
  iss: INTRA_ISSUER,
  sub: "abc-123",
  // the Intra v3 front-end's client, as in its public bundle
  azp: "frontend-react",
  preferred_username: "alepayen",
  exp: Math.floor(now / 1000) + 300,
});

beforeAll(async () => {
  const k = await makeKey("k1");
  privateKey = k.priv;
  // key set also contains an encryption key like Keycloak's real JWKS
  jwks = [{ kid: "enc", kty: "RSA", alg: "RSA-OAEP", use: "enc", n: k.jwk.n, e: k.jwk.e }, k.jwk];
  otherJwks = [(await makeKey("k2")).jwk];
});

describe("verifyIntraJwt", () => {
  it("accepts a valid token and returns the login", async () => {
    const token = "Bearer " + (await sign(validPayload(), privateKey));
    expect(await verifyIntraJwt(token, jwks, now)).toEqual({ login: "alepayen", sub: "abc-123", exp: validPayload().exp });
  });

  it("rejects a token signed by another key", async () => {
    const token = await sign(validPayload(), privateKey);
    expect(await verifyIntraJwt(token, otherJwks, now)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await sign(validPayload(), privateKey);
    const [h, , s] = token.split(".");
    const forged = b64url(JSON.stringify({ ...validPayload(), preferred_username: "victim" }));
    expect(await verifyIntraJwt(`${h}.${forged}.${s}`, jwks, now)).toBeNull();
  });

  it("rejects expired tokens and wrong issuers", async () => {
    expect(await verifyIntraJwt(await sign({ ...validPayload(), exp: Math.floor(now / 1000) - 1 }, privateKey), jwks, now)).toBeNull();
    expect(await verifyIntraJwt(await sign({ ...validPayload(), iss: "https://evil.example/realm" }, privateKey), jwks, now)).toBeNull();
  });

  it("rejects unsupported algorithms and garbage", async () => {
    expect(await verifyIntraJwt(await sign(validPayload(), privateKey, "k1", "HS256"), jwks, now)).toBeNull();
    expect(await verifyIntraJwt("not.a.jwt", jwks, now)).toBeNull();
    expect(await verifyIntraJwt("", jwks, now)).toBeNull();
  });

  it("returns null (not a throw) on a malformed signature segment", async () => {
    const token = await sign(validPayload(), privateKey);
    const [h, p] = token.split(".");
    await expect(verifyIntraJwt(`${h}.${p}.!!!`, jwks, now)).resolves.toBeNull();
    await expect(verifyIntraJwt(`${h}.${p}.`, jwks, now)).resolves.toBeNull();
    await expect(verifyIntraJwt(`${h}.${p}.%%%%`, jwks, now)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: JWKS caching and refresh throttling
// ---------------------------------------------------------------------------

function makeEnv(kvSeed: Record<string, unknown> = {}, vars: Partial<Env> = {}) {
  const kv = new Map<string, string>(
    Object.entries(kvSeed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: string[] = [];
  // Sessions live in D1: a real SQLite with the migrations applied.
  const d1 = new FakeD1();
  const env = {
    BETTER_INTRA_KV: {
      get: async (key: string, opts?: { type?: string }) => {
        const raw = kv.get(key);
        if (raw === undefined) return null;
        return opts?.type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        puts.push(key);
        kv.set(key, value);
      },
      delete: async (key: string) => {
        puts.push(key);
        kv.delete(key);
      },
    },
    better_intra_d1: d1,
    // as in wrangler.json
    JWT_ALLOWED_AZP: "frontend-react",
    ...vars,
  } as unknown as Env;
  return { env, kv, puts, d1 };
}

const authRequest = (token: string) =>
  new Request("https://worker.test/auth/intra", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

describe("handleIntraAuth JWKS handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("verifies with the cached key set without refetching when the kid is known", async () => {
    const { env, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { login: string }).login).toBe("alepayen");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(puts).not.toContain("INTRA_JWKS_CACHE");
  });

  it("does not refetch the JWKS for a bad signature with a known kid", async () => {
    const { env } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const token = await sign(validPayload(), privateKey);
    const [h, p] = token.split(".");
    const forged = await sign({ ...validPayload(), preferred_username: "victim" }, privateKey);
    const res = await handleIntraAuth(authRequest(`${h}.${p}.${forged.split(".")[2]}`), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects expired and foreign tokens before touching KV or the JWKS", async () => {
    const { env } = makeEnv();
    const getSpy = vi.spyOn(env.BETTER_INTRA_KV, "get");
    const expired = await sign({ ...validPayload(), exp: Math.floor(now / 1000) - 1 }, privateKey);
    expect((await handleIntraAuth(authRequest(expired), env)).status).toBe(401);
    const foreign = await sign({ ...validPayload(), iss: "https://evil.example/realm" }, privateKey);
    expect((await handleIntraAuth(authRequest(foreign), env)).status).toBe(401);
    expect((await handleIntraAuth(authRequest("x".repeat(30)), env)).status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refetches once when the kid is unknown, then throttles for 5 minutes", async () => {
    // cache only knows a stale key; the token is signed with k1
    const { env, puts } = makeEnv({ INTRA_JWKS_CACHE: otherJwks });
    const token = await sign(validPayload(), privateKey);

    expect((await handleIntraAuth(authRequest(token), env)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(puts.filter((k) => k === "INTRA_JWKS_CACHE")).toHaveLength(1);

    // an unknown kid inside the throttle window does not trigger another fetch
    const unknownKid = await sign(validPayload(), privateKey, "k-rotated");
    expect((await handleIntraAuth(authRequest(unknownKid), env)).status).toBe(401);
    expect((await handleIntraAuth(authRequest(unknownKid), env)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // once the window has passed a refresh is allowed again
    vi.setSystemTime(now + JWKS_REFRESH_MIN_INTERVAL_MS + 1000);
    const later = await sign({ ...validPayload(), exp: Math.floor(now / 1000) + 3600 }, privateKey, "k-rotated");
    expect((await handleIntraAuth(authRequest(later), env)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never writes KV for forged tokens, even across fresh isolates", async () => {
    // Valid-looking claims and a random kid, signed by a key Keycloak does not
    // have: the old code refetched and rewrote the JWKS once per isolate every
    // 5 minutes, which a few PoPs could turn into the whole daily write budget.
    const { priv: attackerKey } = await makeKey("x");
    const forged = await sign(validPayload(), attackerKey, "attacker-kid");

    for (const seed of [{}, { INTRA_JWKS_CACHE: jwks }]) {
      const { env, puts } = makeEnv(seed);
      for (let isolate = 0; isolate < 5; isolate++) {
        resetJwksRefreshThrottle(); // a new isolate: no in-memory state
        vi.setSystemTime(now + isolate * (JWKS_REFRESH_MIN_INTERVAL_MS + 1000));
        const fresh = await sign(
          { ...validPayload(), exp: Math.floor(now / 1000) + 24 * 3600 },
          attackerKey,
          "attacker-kid",
        );
        expect((await handleIntraAuth(authRequest(isolate ? fresh : forged), env)).status).toBe(401);
      }
      expect(puts).toEqual([]);
    }
  });

  it("does not refetch within an isolate once it holds keys, stored or not", async () => {
    const { env, puts } = makeEnv();
    const { priv: attackerKey } = await makeKey("x");
    // a forged token with the real kid fetches the keys once, stores nothing
    const forged = await sign(validPayload(), attackerKey, "k1");
    expect((await handleIntraAuth(authRequest(forged), env)).status).toBe(401);
    expect((await handleIntraAuth(authRequest(forged), env)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);

    // the next genuine sign-in uses the fetched keys and stores them
    expect((await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(puts).toContain("INTRA_JWKS_CACHE");
  });

  it("answers 503 when the key server is down and no key set is known", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 502 }));
    const { env, puts } = makeEnv();
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/key server/i);
    // a retry inside the throttle window is told the same, without a new fetch
    const retry = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(retry.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
  });

  it("still signs in when caching the key set fails", async () => {
    const { env } = makeEnv();
    let calls = 0;
    const put = env.BETTER_INTRA_KV.put.bind(env.BETTER_INTRA_KV);
    (env.BETTER_INTRA_KV as any).put = async (key: string, value: string) => {
      calls++;
      if (key === "INTRA_JWKS_CACHE") throw new Error("KV put() limit exceeded for the day.");
      return put(key, value);
    };
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("fetches the JWKS when the cache is empty and stores it", async () => {
    const { env, kv } = makeEnv();
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.get("INTRA_JWKS_CACHE")!)).toEqual(jwks);
  });
});

describe("handleIntraAuth JWKS deadline", () => {
  const DEADLINE = FETCH_DEADLINES.jwksMs;

  beforeEach(() => {
    // Date only: the deadline runs on real timers
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    FETCH_DEADLINES.jwksMs = 20;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    FETCH_DEADLINES.jwksMs = DEADLINE;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers the key server's 503 when auth.42.fr never answers, not the client's timeout", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(hangingFetch(calls)));
    const { env, puts } = makeEnv();
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "server_error",
      message: "Intra key server unreachable, retry in a minute",
    });
    expect(calls).toEqual(["https://auth.42.fr/auth/realms/students-42/protocol/openid-connect/certs"]);
    expect(puts).toEqual([]);
  });

  it("answers 503 too when the key set stalls mid-body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => stalledBody(init, '{"keys":[')),
    );
    const { env } = makeEnv();
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: rate limits
// ---------------------------------------------------------------------------

describe("handleIntraAuth rate limits", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const fromIp = (token: string, ip: string) =>
    new Request("https://worker.test/auth/intra", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ token }),
    });

  it("caps sign-ins per login: a replayed valid token stops writing after the limit", async () => {
    const { env, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const token = await sign(validPayload(), privateKey);
    for (let i = 0; i < LIMITS.write.limit; i++) {
      expect((await handleIntraAuth(authRequest(token), env)).status).toBe(200);
    }
    const writes = puts.length;
    const res = await handleIntraAuth(authRequest(token), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(puts.length).toBe(writes);

    // another student is not affected
    const other = await sign({ ...validPayload(), preferred_username: "bob" }, privateKey);
    expect((await handleIntraAuth(authRequest(other), env)).status).toBe(200);

    // and the window passes
    vi.setSystemTime(now + LIMITS.write.periodMs + 1);
    const later = await sign({ ...validPayload(), exp: Math.floor(now / 1000) + 3600 }, privateKey);
    expect((await handleIntraAuth(authRequest(later), env)).status).toBe(200);
  });

  it("caps well-formed garbage per IP before any JWKS work", async () => {
    const { env } = makeEnv({ INTRA_JWKS_CACHE: otherJwks });
    const getSpy = vi.spyOn(env.BETTER_INTRA_KV, "get");
    const { priv: attackerKey } = await makeKey("x");
    const forged = await sign(validPayload(), attackerKey, "k-unknown");
    for (let i = 0; i < LIMITS.anon.limit; i++) {
      expect((await handleIntraAuth(fromIp(forged, "10.0.0.1"), env)).status).toBe(401);
    }
    const reads = getSpy.mock.calls.length;
    expect((await handleIntraAuth(fromIp(forged, "10.0.0.1"), env)).status).toBe(429);
    expect(getSpy.mock.calls.length).toBe(reads);
    // a different address still gets through to the verification
    expect((await handleIntraAuth(fromIp(forged, "10.0.0.2"), env)).status).toBe(401);
  });

  it("counts the addresses of one IPv6 /64 as one client", async () => {
    const { env } = makeEnv({ INTRA_JWKS_CACHE: otherJwks });
    const { priv: attackerKey } = await makeKey("x");
    const forged = await sign(validPayload(), attackerKey, "k-unknown");
    // one host rotating its source address inside its own /64
    for (let i = 0; i < LIMITS.anon.limit; i++) {
      const ip = `2a01:cb10:793:3f00::${(i + 1).toString(16)}`;
      expect((await handleIntraAuth(fromIp(forged, ip), env)).status).toBe(401);
    }
    const sameHost = fromIp(forged, "2A01:CB10:0793:3F00:aaaa:bbbb:cccc:dddd");
    expect((await handleIntraAuth(sameHost, env)).status).toBe(429);
    // the next /64 is another client
    expect((await handleIntraAuth(fromIp(forged, "2a01:cb10:793:3f01::1"), env)).status).toBe(401);
  });

  it("never refuses for a missing address (local dev) and forged tokens cost no write", async () => {
    const { env, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const { priv: attackerKey } = await makeKey("x");
    const forged = await sign(validPayload(), attackerKey, "k1");
    for (let i = 0; i < LIMITS.anon.limit + 5; i++) {
      expect((await handleIntraAuth(authRequest(forged), env)).status).toBe(401);
    }
    expect(puts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: the users row (community counter)
// ---------------------------------------------------------------------------

describe("handleIntraAuth users row", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A sign-in request as Cloudflare delivers it, with the IP's country. */
  const fromFrance = (token: string) => {
    const req = authRequest(token);
    Object.defineProperty(req, "cf", { value: { country: "FR" } });
    return req;
  };

  it("answers the session even when the users row cannot be written", async () => {
    const { env, d1 } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    d1.raw.exec("DROP TABLE users");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleIntraAuth(fromFrance(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    // the token the extension receives is the one stored (hashed), the only one
    expect(
      d1.rows("SELECT token_hash FROM sessions WHERE login_hash = ?", await hashLogin("alepayen")),
    ).toEqual([{ token_hash: tokenHash(token) }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("users row"));
  });

  it("stores the login hash and the date only, never the country, and writes once", async () => {
    const { env } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const d1 = new FakeD1();
    (env as { better_intra_d1: unknown }).better_intra_d1 = d1;
    const hash = await hashLogin("alepayen");

    expect((await handleIntraAuth(fromFrance(await sign(validPayload(), privateKey)), env)).status).toBe(200);
    const first = d1.rows("SELECT hash, country, created_at FROM users");
    expect(first).toEqual([{ hash, country: null, created_at: expect.any(Number) }]);

    expect((await handleIntraAuth(fromFrance(await sign(validPayload(), privateKey)), env)).status).toBe(200);
    expect(d1.rows("SELECT hash, country, created_at FROM users")).toEqual(first);
    for (const sql of d1.prepared) expect(sql).not.toMatch(/country/i);
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: body cap (the route is unauthenticated)
// ---------------------------------------------------------------------------

describe("handleIntraAuth body cap", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Env whose limiters record every call. */
  function limitedEnv() {
    const made = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const anon = new FakeRateLimit();
    const write = new FakeRateLimit();
    Object.assign(made.env, { ANON_RL: anon, WRITE_RL: write });
    return { ...made, anon, write };
  }

  it("refuses a body past the cap with 413 before any KV, JWKS or limiter work", async () => {
    const { env, puts, anon, write } = limitedEnv();
    const getSpy = vi.spyOn(env.BETTER_INTRA_KV, "get");
    // A genuine token padded with spaces (decodeJwt trims them): only the
    // size can refuse it.
    const token = await sign(validPayload(), privateKey);
    const req = new Request("https://worker.test/auth/intra", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ token: token + " ".repeat(MAX_AUTH_BODY_BYTES) }),
    });
    const res = await handleIntraAuth(req, env);
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/too large/i);
    expect(getSpy).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anon.calls).toEqual([]);
    expect(write.calls).toEqual([]);
  });

  it("stops reading a streamed body as soon as it is over the cap", async () => {
    const { env } = limitedEnv();
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    // 16 MB if read to the end
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ >= 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const req = new Request("https://worker.test/auth/intra", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect((await handleIntraAuth(req, env)).status).toBe(413);
    expect(pulled).toBeLessThan(8);
  });

  it("still signs in with a large token under the cap", async () => {
    const { env } = limitedEnv();
    const token = await sign(validPayload(), privateKey);
    const res = await handleIntraAuth(authRequest(token + " ".repeat(MAX_AUTH_BODY_BYTES - 2048)), env);
    expect(res.status).toBe(200);
  });

  it("answers 400 (not 500) for a JSON body that is not an object", async () => {
    const { env } = limitedEnv();
    for (const raw of ["null", "42", '"eyJ.x.y"', "{"]) {
      const req = new Request("https://worker.test/auth/intra", { method: "POST", body: raw });
      expect((await handleIntraAuth(req, env)).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: the client the token was issued to (azp)
// ---------------------------------------------------------------------------

describe("handleIntraAuth client pin (azp)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const { azp: _azp, ...noAzp } = validPayload();

  it("reads JWT_ALLOWED_AZP as a comma-separated list; empty or missing checks nothing", () => {
    expect(azpAllowed("frontend-react", "frontend-react")).toBe(true);
    expect(azpAllowed("frontend-react", " other-client , frontend-react ")).toBe(true);
    expect(azpAllowed("intra", "frontend-react")).toBe(false);
    expect(azpAllowed(undefined, "frontend-react")).toBe(false);
    expect(azpAllowed(["frontend-react"], "frontend-react")).toBe(false);
    expect(azpAllowed(undefined, "")).toBe(true);
    expect(azpAllowed("intra", undefined)).toBe(true);
    expect(azpAllowed("intra", " , ")).toBe(true);
  });

  it("refuses a genuine token of another client, or of none, with the invalid-token 401 and no write", async () => {
    const { env, puts, d1 } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const foreign = await handleIntraAuth(
      authRequest(await sign({ ...validPayload(), iss: "https://evil.example/realm" }, privateKey)),
      env,
    );
    const invalid = { status: foreign.status, body: await foreign.text() };
    expect(invalid.status).toBe(401);
    // "intra" is the v2 server-side client of the same realm
    for (const payload of [{ ...validPayload(), azp: "intra" }, noAzp]) {
      const res = await handleIntraAuth(authRequest(await sign(payload, privateKey)), env);
      expect({ status: res.status, body: await res.text() }).toEqual(invalid);
    }
    expect(puts).toEqual([]);
    expect(d1.rows("SELECT * FROM sessions")).toEqual([]);
    // a 42 rename shows up in the logs: the client id, never the login
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"intra"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"none"'));
    for (const [line] of warn.mock.calls) expect(String(line)).not.toContain("alepayen");
  });

  it("lets every client in when the variable is empty, and any client of the list", async () => {
    const open = makeEnv({ INTRA_JWKS_CACHE: jwks }, { JWT_ALLOWED_AZP: "" });
    expect((await handleIntraAuth(authRequest(await sign(noAzp, privateKey)), open.env)).status).toBe(200);
    const listed = makeEnv({ INTRA_JWKS_CACHE: jwks }, { JWT_ALLOWED_AZP: "frontend-react,intra" });
    const intra = await sign({ ...validPayload(), azp: "intra" }, privateKey);
    expect((await handleIntraAuth(authRequest(intra), listed.env)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// handleIntraAuth: the KV record and the D1 sessions
// ---------------------------------------------------------------------------

describe("sign-in record and sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function signIn(env: Env): Promise<string> {
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  const sessionRows = (d1: FakeD1, hash: string) =>
    d1.rows(
      "SELECT token_hash, created_at FROM sessions WHERE login_hash = ? ORDER BY created_at, token_hash",
      hash,
    );

  it("leaves an existing record alone: settings kept, no KV write, the ten newest sessions kept", async () => {
    const hash = await hashLogin("alepayen");
    const legacy = Array.from({ length: 10 }, (_, i) => `legacy-token-${i}`);
    const { env, kv, d1, puts } = makeEnv({
      INTRA_JWKS_CACHE: jwks,
      [hash]: { sessionTokens: legacy, settings: { A: 1, CUSTOM_CSS: "x" } },
    });
    const before = kv.get(hash);
    const token = await signIn(env);

    // the settings every restore and every visitor read are not rewritten
    expect(kv.get(hash)).toBe(before);
    expect(puts).not.toContain(hash);
    // the ten legacy tokens were copied, then the oldest one made room
    const rows = sessionRows(d1, hash);
    expect(rows).toHaveLength(MAX_SESSIONS);
    expect(rows.map((r) => r.token_hash)).not.toContain(tokenHash(legacy[0]));
    expect(rows[0]).toEqual({
      token_hash: tokenHash(legacy[1]),
      created_at: LEGACY_SESSION_CREATED_AT + 1,
    });
    expect(rows.at(-1)).toEqual({ token_hash: tokenHash(token), created_at: now });
  });

  it("copies a legacy single sessionToken and keeps the record untouched", async () => {
    const hash = await hashLogin("alepayen");
    const { env, kv, d1 } = makeEnv({
      INTRA_JWKS_CACHE: jwks,
      [hash]: { sessionToken: "old-session", settings: { B: 2 } },
    });
    const token = await signIn(env);
    expect(sessionRows(d1, hash).map((r) => r.token_hash).sort()).toEqual(
      [tokenHash("old-session"), tokenHash(token)].sort(),
    );
    expect(JSON.parse(kv.get(hash)!)).toEqual({ sessionToken: "old-session", settings: { B: 2 } });
  });

  it("keeps the earlier sessions working: after two sign-ins every token reads the settings", async () => {
    const hash = await hashLogin("alepayen");
    const { env } = makeEnv({
      INTRA_JWKS_CACHE: jwks,
      [hash]: { sessionTokens: ["legacy-a"], settings: { A: 1 } },
    });
    const first = await signIn(env);
    const second = await signIn(env);
    for (const token of [first, second, "legacy-a"]) {
      const res = await worker.fetch(
        new Request(`https://w.test/api/v1/private/settings?login=${hash}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settings: { A: 1 }, activeSessions: 3, discordId: null, rev: 0 });
    }
  });

  it("creates the record on a first sign-in, with no token in it, and later sign-ins write no KV", async () => {
    const hash = await hashLogin("alepayen");
    const { env, kv, d1, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const token = await signIn(env);
    expect(JSON.parse(kv.get(hash)!)).toEqual({ settings: {} });
    for (const value of kv.values()) expect(value).not.toContain(token);
    expect(d1.rows("SELECT login_hash FROM session_migrations")).toEqual([{ login_hash: hash }]);
    const writes = puts.length;
    await signIn(env);
    expect(puts.length).toBe(writes);
    expect(sessionRows(d1, hash)).toHaveLength(2);
  });

  it("does not take a miss next to a live session for a first sign-in", async () => {
    // A location that cached "no such key" before the first sign-in may
    // still answer null: writing {settings: {}} then would erase the backup.
    const hash = await hashLogin("alepayen");
    const { env, d1, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    addSession(d1, hash, "earlier-session", now - 1000);
    await signIn(env);
    expect(puts).not.toContain(hash);
    expect(sessionRows(d1, hash)).toHaveLength(2);
  });

  it("spends no KV write when the session cannot be stored", async () => {
    const { env, d1, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    d1.raw.exec("DROP TABLE sessions");
    await expect(
      handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env),
    ).rejects.toThrow();
    expect(puts).toEqual([]);
  });

  it("drops the expired sessions and all but the ten newest on each sign-in", async () => {
    const hash = await hashLogin("alepayen");
    const { env, d1 } = makeEnv({ INTRA_JWKS_CACHE: jwks, [hash]: { settings: {} } });
    d1.raw.exec(`INSERT INTO session_migrations (login_hash, migrated_at) VALUES ('${hash}', 0)`);
    const insert = d1.raw.prepare(
      "INSERT INTO sessions (login_hash, token_hash, created_at) VALUES (?, ?, ?)",
    );
    insert.run(hash, "expired", now - SESSION_MAX_AGE_MS - 1);
    for (let i = 0; i < MAX_SESSIONS; i++) insert.run(hash, `live-${i}`, now - 1000 + i);
    const token = await signIn(env);
    const kept = sessionRows(d1, hash).map((r) => r.token_hash);
    expect(kept).toHaveLength(MAX_SESSIONS);
    expect(kept).not.toContain("expired");
    expect(kept).not.toContain("live-0");
    expect(kept.at(-1)).toBe(tokenHash(token));
  });
});

describe("first sign-in record: daily budget and KV busy", () => {
  beforeEach(() => {
    // Date only: the KV retry waits on a real (zero) timer
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    resetJwksRefreshThrottle();
    resetRateLimits();
    KV_RETRY.delayMs = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    KV_RETRY.delayMs = 1100;
  });

  async function signIn(env: Env): Promise<string> {
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  async function settingsOf(env: Env, hash: string, token: string) {
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${hash}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    return { status: res.status, body: await res.json() };
  }

  it("counts the record in the budget, with the sign-in's own cap", async () => {
    const hash = await hashLogin("alepayen");
    const { env, d1, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    // past the pushes' 900, below the sign-ins' 980
    d1.raw
      .prepare("INSERT INTO kv_write_budget (day, login_hash, n) VALUES (?, ?, ?)")
      .run(utcDay(now), BUDGET_ALL, 950);
    await signIn(env);
    expect(puts).toContain(hash);
    expect(d1.rows("SELECT n FROM kv_write_budget WHERE login_hash = ?", hash)).toEqual([{ n: 1 }]);
  });

  it("signs in anyway past the budget, and leaves the record to the first push", async () => {
    const hash = await hashLogin("alepayen");
    const { env, d1, puts } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    d1.raw
      .prepare("INSERT INTO kv_write_budget (day, login_hash, n) VALUES (?, ?, ?)")
      .run(utcDay(now), BUDGET_ALL, DAILY_KV_WRITES_SIGN_IN);
    const token = await signIn(env);
    expect(puts).not.toContain(hash);
    // the session works, and reads as empty settings
    expect(await settingsOf(env, hash, token)).toEqual({
      status: 200,
      body: { settings: {}, activeSessions: 1, discordId: null, rev: 0 },
    });
  });

  it("retries a record KV refused for the per-key limit, and never overwrites one written meanwhile", async () => {
    const hash = await hashLogin("alepayen");
    const first = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const put = first.env.BETTER_INTRA_KV.put.bind(first.env.BETTER_INTRA_KV);
    let refusals = 1;
    first.env.BETTER_INTRA_KV.put = (async (key: string, value: string) => {
      if (key === hash && refusals-- > 0) throw new Error("KV PUT failed: 429 Too Many Requests");
      return put(key, value);
    }) as typeof put;
    await signIn(first.env);
    expect(JSON.parse(first.kv.get(hash)!)).toEqual({ settings: {} });

    // refused, and the student's first push landed in that second
    // (KV takes the retry: only the re-read keeps it from overwriting)
    const second = makeEnv({ INTRA_JWKS_CACHE: jwks });
    let refused = false;
    second.env.BETTER_INTRA_KV.put = (async (key: string, value: string) => {
      if (key === hash && !refused) {
        refused = true;
        second.kv.set(hash, JSON.stringify({ settings: { THEME: "pushed" }, settingsRev: 5 }));
        throw new Error("KV PUT failed: 429 Too Many Requests");
      }
      second.kv.set(key, value);
    }) as typeof put;
    await signIn(second.env);
    expect(JSON.parse(second.kv.get(hash)!)).toEqual({ settings: { THEME: "pushed" }, settingsRev: 5 });
  });

  it("signs in anyway when KV refuses the record twice", async () => {
    const hash = await hashLogin("alepayen");
    const { env, kv } = makeEnv({ INTRA_JWKS_CACHE: jwks });
    const put = env.BETTER_INTRA_KV.put.bind(env.BETTER_INTRA_KV);
    env.BETTER_INTRA_KV.put = (async (key: string, value: string) => {
      if (key === hash) throw new Error("KV PUT failed: 429 Too Many Requests");
      return put(key, value);
    }) as typeof put;
    const token = await signIn(env);
    expect(kv.has(hash)).toBe(false);
    expect((await settingsOf(env, hash, token)).status).toBe(200);
  });
});
