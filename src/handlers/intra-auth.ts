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
/**
 * A token whose `kid` is missing from the cached key set triggers a refetch of
 * the JWKS (Keycloak rotates keys), but this endpoint is unauthenticated: an
 * attacker must not be able to make the worker hammer auth.42.fr and rewrite
 * KV on every request. Refetches are throttled per isolate, and a fetched key
 * set only reaches KV once a token verified with it (see handleIntraAuth).
 */
export const JWKS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

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

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  exp?: number;
  sub?: string;
  preferred_username?: string;
  login?: string;
}

interface DecodedJwt {
  h: string;
  p: string;
  s: string;
  header: JwtHeader;
  payload: JwtPayload;
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
 * Split and decode a compact JWT without verifying it. Returns null when the
 * token is not three base64url segments with JSON header and payload objects.
 */
export function decodeJwt(rawToken: string): DecodedJwt | null {
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (!header || typeof header !== "object") return null;
    if (!payload || typeof payload !== "object") return null;
    return { h, p, s, header, payload };
  } catch {
    return null;
  }
}

/** Cheap claim checks that need no key material: algorithm, issuer, expiry. */
function checkClaims(decoded: DecodedJwt, now: number): boolean {
  const { header, payload } = decoded;
  if (!header.alg || !HASH_FOR_ALG[header.alg]) return false;
  if (payload.iss !== INTRA_ISSUER) return false;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return false;
  return true;
}

/**
 * Verify a Keycloak access token with the given key set. Returns the identity
 * or null when anything (format, algorithm, key, signature, issuer, expiry,
 * missing login) is off. Never throws on malformed input.
 */
export async function verifyIntraJwt(
  rawToken: string,
  jwks: Jwk[],
  now: number = Date.now(),
): Promise<VerifiedIntraToken | null> {
  const decoded = decodeJwt(rawToken);
  if (!decoded) return null;
  // issuer and expiry are checked before any key work: an expired or foreign
  // token never costs a key import or a signature check
  if (!checkClaims(decoded, now)) return null;
  const { h, p, s, header, payload } = decoded;
  const hash = HASH_FOR_ALG[header.alg as string];

  const key = jwks.find(
    (k) =>
      k.kty === "RSA" &&
      (k.use === undefined || k.use === "sig") &&
      (header.kid === undefined || k.kid === header.kid) &&
      k.n &&
      k.e,
  );
  if (!key) return null;

  let ok: boolean;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: header.alg, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    // b64urlDecode throws on a non-base64 signature segment: that is a bad
    // token (401), not a server error
    const signature = b64urlDecode(s);
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const login = (payload.preferred_username || payload.login || "").trim();
  if (!/^[a-z0-9_.-]{2,64}$/i.test(login)) return null;

  return { login, sub: String(payload.sub || ""), exp: payload.exp as number };
}

async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(data.keys)) throw new Error("JWKS: no keys");
  return data.keys;
}

/** Wall-clock time of the last JWKS fetch made by this isolate (0 = never). */
let lastJwksFetchAt = 0;

/**
 * Key set this isolate last fetched from Keycloak. A forged token can make the
 * worker fetch the JWKS but never store it (KV writes are capped at 1,000 a
 * day for the whole namespace), so the fetched set is kept here, where the
 * next token, forged or not, finds it without another request.
 */
let fetchedJwks: { keys: Jwk[]; at: number } | null = null;

/** Test hook: forget the last fetch so a refresh is allowed again. */
export function resetJwksRefreshThrottle(): void {
  lastJwksFetchAt = 0;
  fetchedJwks = null;
}

interface KeySets {
  /** Keys to verify the token with. */
  keys: Jwk[];
  /** What KV holds, to tell whether `keys` is worth storing. */
  stored: Jwk[] | null;
}

/**
 * Key set to verify a token with: the KV copy, else this isolate's last fetch,
 * whichever knows the token's `kid`. When neither does (a rotated key, an empty
 * cache) the JWKS is refetched, at most once per JWKS_REFRESH_MIN_INTERVAL_MS
 * per isolate; inside that window the token is verified against what is known
 * (and fails). Throws when a needed fetch fails, or failed and nothing is known.
 */
async function getJwksForToken(env: Env, kid: string | undefined, now: number): Promise<KeySets> {
  const raw = await env.BETTER_INTRA_KV.get(JWKS_CACHE_KEY, { type: "json" });
  const stored = Array.isArray(raw) && raw.length > 0 ? (raw as Jwk[]) : null;
  if (fetchedJwks && now - fetchedJwks.at > JWKS_TTL_S * 1000) fetchedJwks = null;
  const memory = fetchedJwks?.keys ?? null;

  const knows = (set: Jwk[] | null): set is Jwk[] =>
    !!set && (kid === undefined ? set.length > 0 : set.some((k) => k.kid === kid));
  if (knows(stored)) return { keys: stored, stored };
  if (knows(memory)) return { keys: memory, stored };
  if (now - lastJwksFetchAt < JWKS_REFRESH_MIN_INTERVAL_MS) {
    const known = stored ?? memory;
    // No key at all means the last fetch failed: say so rather than "invalid"
    if (!known) throw new Error("JWKS unavailable, last fetch failed");
    return { keys: known, stored };
  }

  lastJwksFetchAt = now;
  const keys = await fetchJwks();
  fetchedJwks = { keys, at: now };
  return { keys, stored };
}

/**
 * Store the key set a token was just verified with, when KV does not already
 * hold it. Best effort: a failed cache write must not fail the sign-in.
 */
async function storeJwks(env: Env, sets: KeySets): Promise<void> {
  if (sets.stored && JSON.stringify(sets.stored) === JSON.stringify(sets.keys)) return;
  try {
    await env.BETTER_INTRA_KV.put(JWKS_CACHE_KEY, JSON.stringify(sets.keys), {
      expirationTtl: JWKS_TTL_S,
    });
  } catch (e) {
    console.warn(`[intra-auth] JWKS cache write failed: ${e}`);
  }
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

  const now = Date.now();
  // Reject garbage, expired and foreign tokens before touching KV or the JWKS
  // endpoint: this route is unauthenticated.
  const decoded = decodeJwt(body.token);
  if (!decoded || !checkClaims(decoded, now)) {
    return textRes("Invalid or expired Intra token", 401);
  }

  let sets: KeySets;
  try {
    sets = await getJwksForToken(env, decoded.header.kid, now);
  } catch (e) {
    console.warn(`[intra-auth] JWKS fetch failed: ${e}`);
    return textRes("Intra key server unreachable, retry in a minute", 503);
  }
  const verified = await verifyIntraJwt(body.token, sets.keys, now);
  // Nothing is written before this point: a forged or invalid token never
  // costs a KV write.
  if (!verified) return textRes("Invalid or expired Intra token", 401);
  await storeJwks(env, sets);

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
