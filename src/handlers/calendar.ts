import { Env, UserData } from "../types";
import { rateLimited, tooManyRes } from "../rate-limit";
import { jsonRes, readJsonBody, requireSession, textRes } from "../utils";

/**
 * A full year of Intra events is a few tens of KB of ICS. D1 refuses rows past
 * 2 MB with an unhandled error, and the stored body is served to every
 * calendar client every hour, so anything past this is a wrong client.
 */
export const MAX_ICS_BYTES = 256 * 1024;

/**
 * Calendar links (/calendar/<token>.ics) live in D1, one live token per
 * login. They used to be KV keys CALENDAR_TOKEN_<token> -> login hash that
 * nothing ever deleted, so "Regenerate" and "Wipe all data" left every old
 * link serving the student's schedule. A revoked token keeps its row
 * (revoked_at set): nobody can register it again and feed their own events to
 * the calendars still subscribed to it.
 *
 * The legacy KV keys are still read, for links made before this table existed,
 * but only while their login has no row here: the first new link (or a wipe)
 * retires every legacy link of that login at once, including the ones nobody
 * can name any more.
 */
const LEGACY_PREFIX = "CALENDAR_TOKEN_";

/** What the extension generates (crypto.randomUUID()), with room to spare. */
const NEW_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const ensuredDbs = new WeakSet<object>();

/**
 * Created on first use like students_cache: a deploy does not run schema.sql.
 * Called on every path, reads included, so that a missing table never reads
 * as "no link" and lets a retired legacy link through.
 */
async function ensureTokensTable(env: Env): Promise<void> {
  const db = env.better_intra_d1;
  if (ensuredDbs.has(db)) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS calendar_tokens (token TEXT PRIMARY KEY, login_hash TEXT NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS calendar_tokens_login ON calendar_tokens (login_hash)",
    ),
  ]);
  ensuredDbs.add(db);
}

/** Login hash a legacy KV link points to, or null. */
async function readLegacyOwner(
  env: Env,
  token: string,
): Promise<string | null> {
  const raw = await env.BETTER_INTRA_KV.get(`${LEGACY_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.login === "string"
      ? parsed.login
      : typeof parsed === "string"
        ? parsed
        : raw;
  } catch {
    return raw;
  }
}

/**
 * Statements retiring the legacy link named in the user's synced settings
 * (CALENDAR_SYNC_TOKEN), when it really is theirs: settings are written by the
 * client, so a token found there must not let anyone delete someone else's
 * link. The tombstone row keeps the token from being registered again once its
 * KV key is gone.
 */
async function legacyRetirement(
  env: Env,
  loginParam: string,
  settings: Record<string, unknown> | undefined,
  keep?: string,
): Promise<{ stmts: D1PreparedStatement[]; kvKey: string | null }> {
  const named = settings?.CALENDAR_SYNC_TOKEN;
  if (typeof named !== "string" || named.length < 8 || named === keep) {
    return { stmts: [], kvKey: null };
  }
  if ((await readLegacyOwner(env, named)) !== loginParam) {
    return { stmts: [], kvKey: null };
  }
  return {
    stmts: [
      env.better_intra_d1
        .prepare(
          "INSERT OR IGNORE INTO calendar_tokens (token, login_hash, revoked_at) VALUES (?, ?, unixepoch())",
        )
        .bind(named, loginParam),
    ],
    kvKey: `${LEGACY_PREFIX}${named}`,
  };
}

/**
 * Best effort: once the D1 rows are written the link already answers 404, and
 * a KV delete over the daily limit must not turn a done revocation into an
 * error (the extension would keep showing the dead link as current).
 */
async function deleteLegacyKey(env: Env, kvKey: string | null): Promise<void> {
  if (!kvKey) return;
  try {
    await env.BETTER_INTRA_KV.delete(kvKey);
  } catch (e) {
    console.warn(`[calendar] legacy key delete failed: ${e}`);
  }
}

export async function handleCalendarToken(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const denied = requireSession(request, existingData);
  if (denied) return denied;
  const record = existingData as UserData;

  const body = await readJsonBody<{ token?: unknown }>(
    request,
    4096,
    "Body too large",
  );
  if (!body.ok) return body.response;

  const token = body.value?.token;
  if (typeof token !== "string" || !NEW_TOKEN_RE.test(token)) {
    return textRes("Invalid token", 400);
  }

  await ensureTokensTable(env);
  const db = env.better_intra_d1;

  // A token is bound once, for good: taking over a link someone learnt (from a
  // screenshot, a QR code on a screen) would let them rewrite the calendar of
  // everyone subscribed to it.
  const row = await db
    .prepare(
      "SELECT login_hash, revoked_at FROM calendar_tokens WHERE token = ?",
    )
    .bind(token)
    .first<{ login_hash: string; revoked_at: number | null }>();
  if (row) {
    if (row.login_hash === loginParam && row.revoked_at === null) {
      return jsonRes({ ok: true });
    }
    return textRes("Token already in use", 409);
  }
  const legacyOwner = await readLegacyOwner(env, token);
  if (legacyOwner !== null && legacyOwner !== loginParam) {
    return textRes("Token already in use", 409);
  }

  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  const legacy = await legacyRetirement(
    env,
    loginParam,
    record.settings,
    token,
  );
  await db.batch([
    // "New link invalidates the old one": the previous link stops here
    db
      .prepare(
        "UPDATE calendar_tokens SET revoked_at = unixepoch() WHERE login_hash = ? AND revoked_at IS NULL",
      )
      .bind(loginParam),
    ...legacy.stmts,
    db
      .prepare("INSERT INTO calendar_tokens (token, login_hash) VALUES (?, ?)")
      .bind(token, loginParam),
  ]);
  await deleteLegacyKey(env, legacy.kvKey);

  return jsonRes({ ok: true });
}

/**
 * "Wipe all data": revokes every calendar link of the login and deletes the
 * stored calendar. The marker row matters for a login that only ever had
 * legacy links: without a row here, those would keep answering once the user
 * signs in again.
 */
export async function deleteCalendarData(
  env: Env,
  loginParam: string,
  settings: Record<string, unknown> | undefined,
): Promise<void> {
  await ensureTokensTable(env);
  const db = env.better_intra_d1;
  const legacy = await legacyRetirement(env, loginParam, settings);
  await db.batch([
    db
      .prepare(
        "UPDATE calendar_tokens SET revoked_at = unixepoch() WHERE login_hash = ? AND revoked_at IS NULL",
      )
      .bind(loginParam),
    ...legacy.stmts,
    db
      .prepare(
        "INSERT INTO calendar_tokens (token, login_hash, revoked_at) VALUES (?, ?, unixepoch())",
      )
      .bind(`wiped:${crypto.randomUUID()}`, loginParam),
    db
      .prepare("DELETE FROM calendar_ics WHERE login_hash = ?")
      .bind(loginParam),
  ]);
  await deleteLegacyKey(env, legacy.kvKey);
}

export async function handleCalendarUpdate(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);

  const denied = requireSession(request, existingData);
  if (denied) return denied;

  const body = await readJsonBody<{ ics?: unknown }>(
    request,
    MAX_ICS_BYTES,
    `Calendar too large (max ${MAX_ICS_BYTES / 1024} KB)`,
  );
  if (!body.ok) return body.response;

  const ics = body.value?.ics;
  if (typeof ics !== "string" || ics.length < 50) {
    return textRes("Invalid ics body", 400);
  }

  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO calendar_ics (login_hash, ics_body, updated_at) VALUES (?, ?, unixepoch())",
    )
    .bind(loginParam, ics)
    .run();

  return jsonRes({ ok: true });
}

/** Login hash whose calendar `token` serves, or null (unknown or revoked). */
async function resolveCalendarToken(
  token: string,
  env: Env,
): Promise<string | null> {
  await ensureTokensTable(env);
  const db = env.better_intra_d1;
  const row = await db
    .prepare(
      "SELECT login_hash, revoked_at FROM calendar_tokens WHERE token = ?",
    )
    .bind(token)
    .first<{ login_hash: string; revoked_at: number | null }>();
  if (row) return row.revoked_at === null ? row.login_hash : null;

  const login = await readLegacyOwner(env, token);
  if (!login) return null;
  // Any row for this login (live, revoked or wipe marker) supersedes all of
  // its legacy links.
  const newer = await db
    .prepare(
      "SELECT 1 AS found FROM calendar_tokens WHERE login_hash = ? LIMIT 1",
    )
    .bind(login)
    .first<{ found: number }>();
  if (newer) return null;
  // Before this table, "Wipe all data" only deleted the user record: honour
  // those wipes too.
  const user = await env.BETTER_INTRA_KV.get(login);
  return user ? login : null;
}

export async function handleCalendarIcs(
  token: string,
  env: Env,
): Promise<Response> {
  if (!token || token.length < 8 || token.length > 200) {
    return textRes("Invalid token", 404);
  }

  const login = await resolveCalendarToken(token, env);
  if (!login) return textRes("Not found", 404);

  const row = await env.better_intra_d1
    .prepare("SELECT ics_body FROM calendar_ics WHERE login_hash = ?")
    .bind(login)
    .first<{ ics_body: string }>();

  if (!row) {
    const emptyIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//BetterIntra//Events//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "END:VCALENDAR",
    ].join("\r\n");
    return new Response(emptyIcs, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="betterintra-calendar.ics"',
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return new Response(row.ics_body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="betterintra-calendar.ics"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
