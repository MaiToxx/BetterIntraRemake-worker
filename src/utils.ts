import { Env, UserData, TokenResponse, ProjectResponse } from "./types";
import { APP_TOKEN_CACHE } from "./constants";

export function getCallbackUrl(
  request: Request,
  env?: { CALLBACK_URL?: string },
): string {
  const base = env?.CALLBACK_URL?.replace(/\/+$/, "");
  if (base) return `${base}/callback`;
  const url = new URL(request.url);
  return `${url.origin}/callback`;
}

const ALLOWED_ORIGINS = [
  "https://profile-v3.intra.42.fr",
  "https://meta.intra.42.fr",
];

export function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("moz-extension://")) return true;
  if (/^https:\/\/(?:[a-z0-9-]+\.)*intra\.42\.fr$/.test(origin)) return true;
  return false;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const jsonRes = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });

/** Env keys whose values must never appear in a response body. */
const SECRET_ENV_KEYS = [
  "CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "PROJECT_REFRESH_SECRET",
  "PROXY_SECRET",
  "ANNOUNCEMENT_SECRET",
] as const;

/**
 * Answer for an exception nothing else caught. Without it the runtime serves
 * its own HTML error page with no CORS header, which the extension can only
 * read as "could not reach the server". The body carries the message alone
 * (never the stack), cut short, with every configured secret blanked out in
 * case an upstream error echoed one back.
 */
export function serverErrorRes(e: unknown, env: Partial<Env>): Response {
  console.error("[worker] unhandled error:", e);
  let message = e instanceof Error ? e.message : String(e);
  for (const key of SECRET_ENV_KEYS) {
    const secret = env[key];
    if (typeof secret === "string" && secret.length >= 6) {
      message = message.split(secret).join("[redacted]");
    }
  }
  return jsonRes(
    { error: "server_error", message: message.slice(0, 200) },
    500,
  );
}

/**
 * The `login` query parameter is always hashLogin() output. Checking the
 * shape before the KV read keeps the user routes away from the internal keys
 * that share the namespace (APP_TOKEN_CACHE, INTRA_JWKS_CACHE, discord_oauth_*,
 * CALENDAR_TOKEN_*...).
 */
export function isLoginHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * fetch() that only ever reaches hosts `isAllowed` accepts. Redirects are
 * followed by hand (at most `maxRedirects`) and every Location is checked like
 * the first URL, so an allowed host that redirects elsewhere cannot turn the
 * worker into a proxy for any site. Returns null when a hop is refused or the
 * chain is too long.
 */
export async function fetchAllowed(
  url: URL,
  isAllowed: (u: URL) => boolean,
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowed(current)) return null;
    const res = await fetch(current.href, { ...init, redirect: "manual" });
    const location = res.headers.get("Location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    try {
      current = new URL(location, current);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whole body of `res`, or null as soon as it is larger than `maxBytes`
 * (announced by Content-Length or counted while streaming), so that a huge
 * upstream file is never buffered in full.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function getBearerToken(request: Request): string | null {
  return (
    request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  );
}

export function validateSession(
  existingData: { sessionTokens?: string[]; sessionToken?: string },
  token: string,
): boolean {
  const tokens = getTokens(existingData);
  return tokens.includes(token);
}

export const getTokens = (data: any): string[] =>
  Array.isArray(data?.sessionTokens)
    ? data.sessionTokens
    : typeof data?.sessionToken === "string"
      ? [data.sessionToken]
      : [];

export async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * True when this deployment has a real 42 OAuth application. The committed
 * wrangler.json carries a placeholder CLIENT_ID ("TO_FILL_..."): with it every
 * client_credentials or refresh_token call to api.intra.42.fr fails, so the
 * work that needs a 42 app token is skipped instead of failing on every run.
 */
export function has42App(
  env: Pick<Env, "CLIENT_ID" | "CLIENT_SECRET">,
): boolean {
  return (
    typeof env.CLIENT_ID === "string" &&
    env.CLIENT_ID !== "" &&
    !env.CLIENT_ID.startsWith("TO_FILL") &&
    !!env.CLIENT_SECRET
  );
}

const pendingTokens = new WeakMap<Env, Promise<string>>();

export async function getAppToken(env: Env): Promise<string> {
  // Same outcome as the failed POST below, minus a KV read and a request
  // that cannot succeed.
  if (!has42App(env)) throw new Error("No 42 application configured");

  const cached = await env.BETTER_INTRA_KV.get<{
    token: string;
    expires: number;
  }>(APP_TOKEN_CACHE, { type: "json" });

  if (cached && Date.now() < cached.expires) {
    return cached.token;
  }

  if (pendingTokens.has(env)) {
    return pendingTokens.get(env)!;
  }

  const promise = (async () => {
    const res = await fetch("https://api.intra.42.fr/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
      }),
    });

    if (!res.ok) throw new Error("Failed to get app token");

    const data = (await res.json()) as TokenResponse;
    const token = data.access_token;
    if (!token) throw new Error("Missing access_token in app token response");
    const expiresIn = Math.max(60, (data.expires_in ?? 7200) - 60);
    const expires = Date.now() + expiresIn * 1000;

    await env.BETTER_INTRA_KV.put(
      APP_TOKEN_CACHE,
      JSON.stringify({ token, expires }),
      { expirationTtl: expiresIn },
    );

    return token;
  })();

  pendingTokens.set(env, promise);
  try {
    return await promise;
  } finally {
    pendingTokens.delete(env);
  }
}

export interface CursusInfo {
  name: string;
  slug: string;
  kind?: string;
}

const CURSUS_CACHE_TTL = 30 * 24 * 60 * 60;

export async function getCursusMap(
  env: Env,
): Promise<Record<number, CursusInfo>> {
  const { results } = await env.better_intra_d1
    .prepare("SELECT id, name, slug, kind, cached_at FROM cursus")
    .all<{
      id: number;
      name: string;
      slug: string;
      kind: string;
      cached_at: number;
    }>();

  const map: Record<number, CursusInfo> = {};
  for (const row of results) {
    map[row.id] = { name: row.name, slug: row.slug, kind: row.kind };
  }

  const newest = results.reduce((max, r) => Math.max(max, r.cached_at), 0);
  if (results.length > 0 && newest > Date.now() / 1000 - CURSUS_CACHE_TTL) {
    return map;
  }

  try {
    const token = await getAppToken(env);
    const stmts: D1PreparedStatement[] = [];
    for (let page = 1; ; page++) {
      const res = await fetch(
        `https://api.intra.42.fr/v2/cursus?page[size]=100&page[number]=${page}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) break;
      const rows = (await res.json()) as Array<{
        id: number;
        name: string;
        slug: string;
        kind?: string;
      }>;
      if (rows.length === 0) break;
      for (const c of rows) {
        map[c.id] = { name: c.name, slug: c.slug, kind: c.kind };
        stmts.push(
          env.better_intra_d1
            .prepare(
              "INSERT OR REPLACE INTO cursus (id, name, slug, kind) VALUES (?, ?, ?, ?)",
            )
            .bind(c.id, c.name, c.slug, c.kind ?? null),
        );
      }
      if (rows.length < 100) break;
    }
    if (stmts.length > 0) await env.better_intra_d1.batch(stmts);
  } catch (e) {
    console.warn("[getCursusMap] fetch failed:", e);
  }
  return map;
}

export async function updateProjectMap(env: Env, appToken: string) {
  let allProjects: any[] = [];
  let page = 1;

  while (true) {
    const res = await fetch(
      `https://api.intra.42.fr/v2/projects?per_page=100&page=${page}`,
      {
        headers: { Authorization: `Bearer ${appToken}` },
      },
    );

    if (!res.ok) return;

    const projects = (await res.json()) as ProjectResponse[];
    if (projects.length === 0) break;

    allProjects = allProjects.concat(projects);
    page++;
  }

  const batchSize = 100;
  for (let i = 0; i < allProjects.length; i += batchSize) {
    const batch = allProjects
      .slice(i, i + batchSize)
      .map((p) =>
        env.better_intra_d1
          .prepare(
            "INSERT OR REPLACE INTO projects (id, name, slug) VALUES (?, ?, ?)",
          )
          .bind(p.id, p.name, p.slug),
      );
    await env.better_intra_d1.batch(batch);
  }
}

const keyCache = new WeakMap<Env, CryptoKey>();

async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  const cached = keyCache.get(env);
  if (cached) return cached;

  const keyBase64 = env.TOKEN_ENCRYPTION_KEY;
  if (!keyBase64) throw new Error("TOKEN_ENCRYPTION_KEY not set");

  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  keyCache.set(env, key);
  return key;
}

export async function encryptTokenData(
  env: Env,
  data: object,
): Promise<string> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptTokenData<T = Record<string, unknown>>(
  env: Env,
  encrypted: string,
): Promise<T> {
  const key = await getEncryptionKey(env);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

export async function getUserToken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
  country?: string | null,
): Promise<string> {
  const d1Row = await getTokenFromD1(env, loginParam);
  const d1Token = d1Row?.forty_two_token ?? null;
  const encryptedToken = d1Token ?? userData?.fortyTwoToken;

  if (encryptedToken && !d1Token && userData?.fortyTwoToken) {
    await saveTokenToD1(env, loginParam, userData.fortyTwoToken, country);
  }

  if (country && d1Row && d1Row.country === null) {
    await env.better_intra_d1
      .prepare(
        "UPDATE users SET country = ? WHERE hash = ? AND country IS NULL",
      )
      .bind(country, loginParam)
      .run();
  }

  if (!encryptedToken) {
    console.log(
      `[getUserToken] ${loginParam}: no fortyTwoToken, using app token`,
    );
    await markTokenBroken(env, userData, loginParam);
    return getAppToken(env);
  }

  let tokenData: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  try {
    tokenData = await decryptTokenData<typeof tokenData>(env, encryptedToken);
  } catch {
    console.log(
      `[getUserToken] ${loginParam}: decryption failed, using app token`,
    );
    await markTokenBroken(env, userData, loginParam);
    return getAppToken(env);
  }

  if (Date.now() < tokenData.expires_at - 60000) {
    console.log(`[getUserToken] ${loginParam}: using cached user token`);
    await clearTokenBroken(env, userData, loginParam);
    return tokenData.access_token;
  }

  if (tokenData.refresh_token) {
    try {
      console.log(`[getUserToken] ${loginParam}: refreshing user token`);
      const res = await fetch("https://api.intra.42.fr/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.CLIENT_ID,
          client_secret: env.CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as TokenResponse;
        const newAccessToken = data.access_token;
        if (!newAccessToken) {
          console.log(
            `[getUserToken] ${loginParam}: refresh response missing access_token`,
          );
          await markTokenBroken(env, userData, loginParam);
          return getAppToken(env);
        }
        const newTokenData = {
          access_token: newAccessToken,
          refresh_token: data.refresh_token ?? tokenData.refresh_token,
          expires_at: Date.now() + (data.expires_in ?? 7200) * 1000,
        };
        const encrypted = await encryptTokenData(env, newTokenData);
        await saveTokenToD1(env, loginParam, encrypted);
        await clearTokenBroken(env, userData, loginParam);
        console.log(
          `[getUserToken] ${loginParam}: refreshed and stored new user token to D1`,
        );
        return newAccessToken;
      }

      console.log(
        `[getUserToken] ${loginParam}: refresh failed (${res.status}), using app token`,
      );
    } catch {
      console.log(
        `[getUserToken] ${loginParam}: refresh error, using app token`,
      );
    }
  } else {
    console.log(
      `[getUserToken] ${loginParam}: no refresh_token, using app token`,
    );
  }

  await markTokenBroken(env, userData, loginParam);
  return getAppToken(env);
}

export async function markTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<void> {
  if (!userData) return;
  if (userData.tokenBroken) return;
  userData.tokenBroken = true;
  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}
}

async function clearTokenBroken(
  env: Env,
  userData: UserData | null,
  loginParam: string,
): Promise<void> {
  if (!userData) return;
  if (!userData.tokenBroken) return;
  userData.tokenBroken = false;
  try {
    await env.BETTER_INTRA_KV.put(loginParam, JSON.stringify(userData));
  } catch {}
}

async function getTokenFromD1(
  env: Env,
  hash: string,
): Promise<{ forty_two_token: string | null; country: string | null } | null> {
  try {
    const row = await env.better_intra_d1
      .prepare("SELECT forty_two_token, country FROM users WHERE hash = ?")
      .bind(hash)
      .first<{ forty_two_token: string | null; country: string | null }>();
    return row ?? null;
  } catch {
    return null;
  }
}

async function saveTokenToD1(
  env: Env,
  hash: string,
  encryptedToken: string,
  country?: string | null,
): Promise<void> {
  try {
    await env.better_intra_d1
      .prepare(
        "INSERT INTO users (hash, forty_two_token, country) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET forty_two_token = ?, country = COALESCE(users.country, ?)",
      )
      .bind(
        hash,
        encryptedToken,
        country ?? null,
        encryptedToken,
        country ?? null,
      )
      .run();
  } catch (e) {
    console.warn(`[saveTokenToD1] failed for ${hash.slice(0, 6)}: ${e}`);
  }
}
