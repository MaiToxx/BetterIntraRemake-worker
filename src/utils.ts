import { Env, UserData } from "./types";

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
  // JSON and text bodies opened as a page on the worker's own origin must
  // never be sniffed into HTML.
  "X-Content-Type-Options": "nosniff",
};

export const jsonRes = (
  body: any,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...headers },
  });

export const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType, ...headers },
  });

/** Env keys whose values must never appear in a response body. */
const SECRET_ENV_KEYS = ["ANNOUNCEMENT_SECRET"] as const;

/**
 * Answer for an exception nothing else caught. Without it the runtime serves
 * its own HTML error page with no CORS header, which the extension can only
 * read as "could not reach the server". The body carries the message alone
 * (never the stack), cut short, with every configured secret blanked out in
 * case an upstream error echoed one back. The log line names the method and
 * path so a failing route can be told apart in Workers Logs, but never the
 * query string (login hashes, calendar tokens), and never a secret part of
 * the path either: see redactPath().
 */
/**
 * A path as it may appear in the logs: the calendar link's token (the secret
 * link itself: whoever reads it reads the feed), and login hashes (the
 * /img/<hash>/<slot> routes) are replaced by placeholders. Workers Logs keep
 * lines for days, and a D1 outage used to write every subscriber's link
 * there on each calendar refresh.
 */
export function redactPath(pathname: string): string {
  return pathname
    .replace(/^\/calendar\/[^/]+$/, "/calendar/:token.ics")
    .replace(/\/[0-9a-f]{64}(?=\/|$)/gi, "/:hash")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=[/.]|$)/gi, "/:id");
}

export function serverErrorRes(
  e: unknown,
  env: Partial<Env>,
  request?: Request,
): Response {
  let where = "?";
  if (request) {
    let pathname = "?";
    try {
      pathname = redactPath(new URL(request.url).pathname);
    } catch {}
    where = `${request.method} ${pathname}`;
  }
  const name = e instanceof Error ? e.name : typeof e;
  let message = e instanceof Error ? e.message : String(e);
  console.error(`[worker] unhandled error: ${where} ${name}: ${message}`);
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
 * that share the namespace (INTRA_JWKS_CACHE, ANNOUNCEMENT, CLUSTER_SVG_URLS,
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
 * upstream file, or a huge client body, is never buffered in full.
 */
export async function readBodyCapped(
  res: Response | Request,
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

export type JsonBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * JSON body of a client request, or the response to send instead: 413 past
 * `maxBytes` (the body is dropped as soon as it is over, never buffered
 * whole), 400 when it is not JSON. The cap is in bytes on the wire, which is
 * what the KV record and the D1 row end up holding. `tooLarge` is the 413's
 * text, or a function building the whole response.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes: number,
  tooLarge: string | (() => Response),
): Promise<JsonBody<T>> {
  const bytes = await readBodyCapped(request, maxBytes);
  if (!bytes) {
    const response = typeof tooLarge === "string" ? textRes(tooLarge, 413) : tooLarge();
    return { ok: false, response };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch {
    return { ok: false, response: textRes("Invalid JSON body", 400) };
  }
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

/**
 * Guard of every private route. One and the same 401 for a missing header, an
 * unknown login and a wrong token: the login parameter is sha256 of a public
 * login, so a distinct "user not found" would tell anyone which students use
 * the extension (and the calendar, the tracker...). Returns null when the
 * session is valid.
 */
export function requireSession(
  request: Request,
  existingData: UserData | null,
): Response | null {
  const token = getBearerToken(request);
  if (!token || !existingData || !validateSession(existingData, token)) {
    return textRes("Unauthorized", 401);
  }
  return null;
}

export async function hashLogin(login: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(login.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
