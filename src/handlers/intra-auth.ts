/**
 * Login without a 42 OAuth application.
 *
 * The Intra v3 front-end authenticates its own API calls with a Keycloak JWT
 * (realm "students-42" on auth.42.fr). The extension already sees that token
 * on every Intra page. This endpoint verifies the token's RS256 signature
 * against Keycloak's public keys (JWKS), checks issuer and expiry, and opens a
 * Better Intra session for the login carried by the token, exactly like the
 * OAuth callback does, minus the 42 API tokens (features that call the 42
 * API server-side stay unavailable on such sessions).
 *
 *   POST /auth/intra   { "token": "Bearer eyJ..." }
 *   -> { "token": "<session token>", "login": "<intra login>" }
 */
import { Env, UserData } from "../types";
import { getTokens, hashLogin, jsonRes, textRes } from "../utils";

export const INTRA_ISSUER = "https://auth.42.fr/auth/realms/students-42";
const JWKS_URL = `${INTRA_ISSUER}/protocol/openid-connect/certs`;
const JWKS_CACHE_KEY = "INTRA_JWKS_CACHE";
const JWKS_TTL_S = 6 * 60 * 60;

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface VerifiedIntraToken {
  login: string;
  sub: string;
  exp: number;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const HASH_FOR_ALG: Record<string, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};

/**
 * Verify a Keycloak access token with the given key set. Returns the identity
 * or null when anything (format, algorithm, key, signature, issuer, expiry,
 * missing login) is off.
 */
export async function verifyIntraJwt(
  rawToken: string,
  jwks: Jwk[],
  now: number = Date.now(),
): Promise<VerifiedIntraToken | null> {
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    exp?: number;
    sub?: string;
    preferred_username?: string;
    login?: string;
  };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }

  const hash = header.alg ? HASH_FOR_ALG[header.alg] : undefined;
  if (!hash) return null;

  const key = jwks.find(
    (k) =>
      k.kty === "RSA" &&
      (k.use === undefined || k.use === "sig") &&
      (header.kid === undefined || k.kid === header.kid) &&
      k.n &&
      k.e,
  );
  if (!key) return null;

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: header.alg, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  if (payload.iss !== INTRA_ISSUER) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;

  const login = (payload.preferred_username || payload.login || "").trim();
  if (!/^[a-z0-9_.-]{2,64}$/i.test(login)) return null;

  return { login, sub: String(payload.sub || ""), exp: payload.exp };
}

async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(data.keys)) throw new Error("JWKS: no keys");
  return data.keys;
}

async function getJwks(env: Env, forceRefresh = false): Promise<Jwk[]> {
  if (!forceRefresh) {
    const cached = await env.BETTER_INTRA_KV.get(JWKS_CACHE_KEY, { type: "json" });
    if (Array.isArray(cached) && cached.length > 0) return cached as Jwk[];
  }
  const keys = await fetchJwks();
  await env.BETTER_INTRA_KV.put(JWKS_CACHE_KEY, JSON.stringify(keys), {
    expirationTtl: JWKS_TTL_S,
  });
  return keys;
}

export async function handleIntraAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return textRes("Invalid JSON body", 400);
  }
  if (typeof body.token !== "string" || body.token.length < 20) {
    return textRes("Missing token", 400);
  }

  // Verify with the cached key set; on failure retry once with fresh keys
  // (Keycloak rotates them).
  let verified = await verifyIntraJwt(body.token, await getJwks(env));
  if (!verified) verified = await verifyIntraJwt(body.token, await getJwks(env, true));
  if (!verified) return textRes("Invalid or expired Intra token", 401);

  const rawLogin = verified.login;
  const hashedLogin = await hashLogin(rawLogin);
  const newSessionToken = crypto.randomUUID();
  const existing: UserData =
    (await env.BETTER_INTRA_KV.get(hashedLogin, { type: "json" })) || {};

  const activeTokens = getTokens(existing);
  activeTokens.push(newSessionToken);
  if (activeTokens.length > 10) activeTokens.shift();

  await env.BETTER_INTRA_KV.put(
    hashedLogin,
    JSON.stringify({
      ...existing,
      sessionTokens: activeTokens,
      sessionToken: undefined,
      settings: existing.settings || {},
    }),
  );

  const country = request.cf?.country || null;
  await env.better_intra_d1
    .prepare(
      "INSERT INTO users (hash, country) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET country = COALESCE(users.country, ?)",
    )
    .bind(hashedLogin, country, country)
    .run();

  return jsonRes({ token: newSessionToken, login: rawLogin });
}
