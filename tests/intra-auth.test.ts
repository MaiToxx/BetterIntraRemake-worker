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

// Node 20+ exposes WebCrypto globally, like the Workers runtime does.
const subtle = globalThis.crypto.subtle;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let jwks: Jwk[];
let otherJwks: Jwk[];

async function makeKey(kid: string) {
  const pair = await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
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
    expect((await res.json()).login).toBe("alepayen");
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

  it("fetches the JWKS when the cache is empty and stores it", async () => {
    const { env, kv } = makeEnv();
    const res = await handleIntraAuth(authRequest(await sign(validPayload(), privateKey)), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.get("INTRA_JWKS_CACHE")!)).toEqual(jwks);
  });
});
