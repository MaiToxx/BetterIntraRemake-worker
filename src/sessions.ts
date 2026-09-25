import { Env, UserData } from "./types";
import { getBearerToken, getTokens, sha256Hex, unauthorizedRes } from "./utils";

/**
 * Sessions of the Intra sign-in, kept in D1 (migrations/0002_sessions.sql).
 *
 * They used to be an array of tokens inside the KV record, next to the
 * settings, and every sign-in, sign-out and push rewrote both halves from one
 * read. KV is last-write-wins and a location may serve a copy up to 60 s old,
 * so a push could drop a session opened a moment before (its first call then
 * got a 401) and a sign-out racing a push brought the removed token back. D1
 * has no read replica here: a sign-in, a sign-out or a revocation is seen by
 * the next request wherever it lands, and none of them spends one of the
 * 1,000 KV writes a day any more. Only the SHA-256 of a token is stored, so a
 * dump of the table holds no working credential.
 *
 * Records from before keep their tokens in KV until the login's first request
 * to this worker: that request copies them into D1, hashed, and writes the
 * marker row (session_migrations) in the same transaction. From then on the
 * KV list is never read again, and it goes with the record's next write. No
 * bulk migration: one KV write per user would come out of the shared daily
 * 1,000.
 */

/** Sessions kept per login: a sign-in past this drops the oldest. */
export const MAX_SESSIONS = 10;

/**
 * A session older than this is refused like a revoked one. The Intra token
 * behind a sign-in lasts minutes, but the session it bought used to last
 * forever: through an Intra sign-out, a lost laptop, leaving 42. The 401 makes
 * every extension build, older ones included, offer "Sign in again".
 */
export const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Sign-in date given to the tokens copied from KV, which never recorded one:
 * the day sessions moved to D1, fixed. The date of the copy would give a
 * token that sat unused for years a fresh year whenever its login shows up.
 * Token i of the record gets this + i ms, so the order the record kept
 * (oldest first) still decides which one a new sign-in drops.
 */
export const LEGACY_SESSION_CREATED_AT = Date.UTC(2026, 8, 25);

/**
 * The login's KV record as a handler receives it. The router passes a
 * loader, so that a route which only needs the session (most of them, once
 * the login is migrated) never reads, nor parses, a record of up to 256 KB.
 * Tests may pass the record itself.
 */
export type RecordSource = UserData | null | (() => Promise<UserData | null>);

/** `source` as a function that reads the record at most once. */
export function recordLoader(
  source: RecordSource,
): () => Promise<UserData | null> {
  if (typeof source !== "function") return async () => source;
  let pending: Promise<UserData | null> | null = null;
  return () => (pending ??= source());
}

/** Lazy, read-once loader of the KV record of `loginHash`. */
export function kvRecord(
  env: Env,
  loginHash: string,
): () => Promise<UserData | null> {
  return recordLoader(() =>
    env.BETTER_INTRA_KV.get<UserData>(loginHash, { type: "json" }),
  );
}

export interface Session {
  loginHash: string;
  /** SHA-256 (hex) of the caller's token: the row's key, never the token. */
  tokenHash: string;
  createdAt: number;
}

export function isExpired(createdAt: number, now: number): boolean {
  return now - createdAt > SESSION_MAX_AGE_MS;
}

/**
 * Statements copying the legacy tokens of `record` (the newest MAX_SESSIONS)
 * into D1, then marking the login as migrated. Every insert only runs while
 * the marker is absent and the marker comes last, and a batch is one
 * transaction: a request that saw the login unmigrated but commits after
 * another copy did inserts nothing, so a late copy never brings back a
 * session that a sign-out, a revocation or a sign-in's pruning removed since.
 */
export async function legacySessionStatements(
  env: Env,
  loginHash: string,
  record: UserData | null,
  now: number = Date.now(),
): Promise<D1PreparedStatement[]> {
  const db = env.better_intra_d1;
  const tokens = getTokens(record)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(-MAX_SESSIONS);
  const stmts: D1PreparedStatement[] = [];
  for (const [i, token] of tokens.entries()) {
    stmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO sessions (login_hash, token_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM session_migrations WHERE login_hash = ?)",
        )
        .bind(loginHash, await sha256Hex(token), LEGACY_SESSION_CREATED_AT + i, loginHash),
    );
  }
  stmts.push(
    db
      .prepare(
        "INSERT OR IGNORE INTO session_migrations (login_hash, migrated_at) VALUES (?, ?)",
      )
      .bind(loginHash, now),
  );
  return stmts;
}

interface SessionLookup {
  migrated: number;
  created_at: number | null;
}

/** Whether the login is migrated, and the session's sign-in date: one query. */
async function lookup(
  env: Env,
  loginHash: string,
  tokenHash: string,
): Promise<SessionLookup> {
  const row = await env.better_intra_d1
    .prepare(
      "SELECT EXISTS (SELECT 1 FROM session_migrations WHERE login_hash = ?) AS migrated, (SELECT created_at FROM sessions WHERE login_hash = ? AND token_hash = ?) AS created_at",
    )
    .bind(loginHash, loginHash, tokenHash)
    .first<SessionLookup>();
  return row ?? { migrated: 0, created_at: null };
}

/**
 * The caller's live session, or null. The first call for a login that is
 * still listed in KV copies the record's tokens first (see
 * legacySessionStatements). A login with neither a marker nor a record is
 * refused without any write: a made-up hash costs one read and nothing else.
 */
export async function authenticate(
  request: Request,
  env: Env,
  loginHash: string,
  record: () => Promise<UserData | null>,
): Promise<Session | null> {
  const token = getBearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  let found = await lookup(env, loginHash, tokenHash);
  if (!found.migrated) {
    const data = await record();
    if (!data) return null;
    await env.better_intra_d1.batch(
      await legacySessionStatements(env, loginHash, data),
    );
    found = await lookup(env, loginHash, tokenHash);
  }
  if (found.created_at === null || isExpired(found.created_at, Date.now())) {
    return null;
  }
  return { loginHash, tokenHash, createdAt: found.created_at };
}

/**
 * Guard of every private route: null when the caller holds a live session,
 * else the one 401 (see unauthorizedRes) for a missing header, an unknown
 * login, a wrong, revoked or expired token alike.
 */
export async function requireSession(
  request: Request,
  env: Env,
  loginHash: string,
  record: () => Promise<UserData | null>,
): Promise<Response | null> {
  return (await authenticate(request, env, loginHash, record))
    ? null
    : unauthorizedRes();
}

export interface NewSession {
  /** The token, the only time it exists in clear here. */
  token: string;
  /** No live session existed before this one (a first sign-in, or after a wipe). */
  first: boolean;
}

/**
 * Opens a session. `record` is the login's KV record as the sign-in read it:
 * a login still listed in KV has its tokens copied in the same transaction,
 * so a sign-in never signs the other browsers out. The same batch drops the
 * expired sessions and all but the MAX_SESSIONS newest.
 */
export async function createSession(
  env: Env,
  loginHash: string,
  record: UserData | null,
  now: number = Date.now(),
): Promise<NewSession> {
  const token = crypto.randomUUID();
  const db = env.better_intra_d1;
  const legacy = await legacySessionStatements(env, loginHash, record, now);
  const results = await db.batch([
    ...legacy,
    // the live sessions before this one, copied ones included: `first`
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE login_hash = ? AND created_at >= ?",
      )
      .bind(loginHash, now - SESSION_MAX_AGE_MS),
    db
      .prepare(
        "INSERT INTO sessions (login_hash, token_hash, created_at) VALUES (?, ?, ?)",
      )
      .bind(loginHash, await sha256Hex(token), now),
    db
      .prepare(
        "DELETE FROM sessions WHERE login_hash = ? AND (created_at < ? OR token_hash NOT IN (SELECT token_hash FROM sessions WHERE login_hash = ? ORDER BY created_at DESC, token_hash DESC LIMIT ?))",
      )
      .bind(loginHash, now - SESSION_MAX_AGE_MS, loginHash, MAX_SESSIONS),
  ]);
  const before = results[legacy.length]?.results?.[0] as { n?: number } | undefined;
  return { token, first: !before?.n };
}

/** Sign-out: the caller's session only. */
export async function deleteSession(env: Env, session: Session): Promise<void> {
  await env.better_intra_d1
    .prepare("DELETE FROM sessions WHERE login_hash = ? AND token_hash = ?")
    .bind(session.loginHash, session.tokenHash)
    .run();
}

/**
 * "Wipe all data": every session of the login. The marker row stays: a
 * location still serving the deleted KV record from its cache must not be
 * able to copy the wiped tokens back.
 */
export async function deleteAllSessions(env: Env, loginHash: string): Promise<void> {
  await env.better_intra_d1
    .prepare("DELETE FROM sessions WHERE login_hash = ?")
    .bind(loginHash)
    .run();
}

/**
 * "Sign out other browsers": every session of the login but the caller's.
 * Returns how many live sessions went; expired rows are removed on the way
 * without being counted, since no list showed them.
 */
export async function revokeOtherSessions(
  env: Env,
  session: Session,
  now: number = Date.now(),
): Promise<number> {
  const db = env.better_intra_d1;
  const [, live] = await db.batch([
    db
      .prepare(
        "DELETE FROM sessions WHERE login_hash = ? AND token_hash <> ? AND created_at < ?",
      )
      .bind(session.loginHash, session.tokenHash, now - SESSION_MAX_AGE_MS),
    db
      .prepare("DELETE FROM sessions WHERE login_hash = ? AND token_hash <> ?")
      .bind(session.loginHash, session.tokenHash),
  ]);
  return live.meta.changes ?? 0;
}

export interface SessionRow {
  tokenHash: string;
  createdAt: number;
}

/** The login's live sessions, newest first. */
export async function listSessions(
  env: Env,
  loginHash: string,
  now: number = Date.now(),
): Promise<SessionRow[]> {
  const { results } = await env.better_intra_d1
    .prepare(
      "SELECT token_hash, created_at FROM sessions WHERE login_hash = ? AND created_at >= ? ORDER BY created_at DESC, token_hash DESC",
    )
    .bind(loginHash, now - SESSION_MAX_AGE_MS)
    .all<{ token_hash: string; created_at: number }>();
  return results.map((r) => ({ tokenHash: r.token_hash, createdAt: r.created_at }));
}

/** How many live sessions the login has (the account card's "Sign-ins n/10"). */
export async function countSessions(
  env: Env,
  loginHash: string,
  now: number = Date.now(),
): Promise<number> {
  const row = await env.better_intra_d1
    .prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE login_hash = ? AND created_at >= ?",
    )
    .bind(loginHash, now - SESSION_MAX_AGE_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
