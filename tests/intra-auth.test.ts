import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  INTRA_ISSUER,
  JWKS_REFRESH_MIN_INTERVAL_MS,
  handleIntraAuth,
  resetJwksRefreshThrottle,
  verifyIntraJwt,
  type Jwk,
} from "../src/handlers/intra-auth";
import type { Env } from "../src/types";
import { LIMITS, resetRateLimits } from "../src/rate-limit";

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

function makeEnv(kvSeed: Record<string, unknown> = {}) {
  const kv = new Map<string, string>(
    Object.entries(kvSeed).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  const puts: string[] = [];
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
    better_intra_d1: {
      prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
    },
  } as unknown as Env;
  return { env, kv, puts };
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
