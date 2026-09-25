/**
 * In-memory stand-ins for the worker's bindings.
 *
 * FakeD1 runs the SQL on a real SQLite (node:sqlite), built by applying
 * migrations/*.sql in order like `wrangler d1 migrations apply` does, so
 * constraints, JOINs and batches behave like D1 instead of like a mock that
 * pattern-matches the queries. FakeKV counts writes and deletes, the budget
 * the free plan caps at 1,000 a day.
 */
import type { Env } from "../../src/types";

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

// Loaded without an import so the worker's tsconfig (no Node types) is happy.
const nodeProcess = (globalThis as any).process;
const { DatabaseSync } = nodeProcess.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
const { readFileSync, readdirSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
};
const { createHash } = nodeProcess.getBuiltinModule("node:crypto") as {
  createHash(alg: "sha256"): { update(s: string): { digest(enc: "hex"): string } };
};
const { fileURLToPath } = nodeProcess.getBuiltinModule("node:url") as {
  fileURLToPath(url: string): string;
};
const { dirname, join } = nodeProcess.getBuiltinModule("node:path") as {
  dirname(path: string): string;
  join(...paths: string[]): string;
};

// A path, not new URL(..., import.meta.url): the extension's contract test
// (tests/worker-contract.test.ts there) loads this file under jsdom, whose
// URL class does not resolve file: URLs.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath((import.meta as { url: string }).url)),
  "../../migrations",
);

/** migrations/*.sql, in the order wrangler applies them (by name). */
export const MIGRATIONS: { name: string; sql: string }[] = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));

class FakeStatement {
  constructor(
    private readonly db: SqliteDatabase,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...this.params);
    return { results: rows.map((r) => ({ ...r }) as T), success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }

  /** What D1's batch() answers for one statement: its rows and its changes. */
  result(): { success: true; results: Record<string, unknown>[]; meta: { changes: number } } {
    const stmt = this.db.prepare(this.sql);
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { success: true, results: stmt.all(...this.params).map((r) => ({ ...r })), meta: { changes: 0 } };
    }
    const r = stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
}

export class FakeD1 {
  readonly raw: SqliteDatabase;
  /** Every SQL text prepared, in order. */
  readonly prepared: string[] = [];

  constructor(opts: { schema?: boolean } = {}) {
    this.raw = new DatabaseSync(":memory:");
    if (opts.schema !== false) {
      for (const m of MIGRATIONS) this.raw.exec(m.sql);
    }
  }

  prepare(sql: string): FakeStatement {
    this.prepared.push(sql);
    return new FakeStatement(this.raw, sql);
  }

  /** Like D1: all statements in one transaction, rolled back on error. */
  async batch(stmts: FakeStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(s.result());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  /** Test helper: rows of a query, run directly. */
  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw
      .prepare(sql)
      .all(...params)
      .map((r) => ({ ...r }));
  }
}

/** What KV throws for a second write to one key within a second. */
export const kvRateLimitError = () => new Error("KV PUT failed: 429 Too Many Requests");

/** The login's daily KV write count (src/budget.ts), 0 without a row. */
export function budgetCount(d1: FakeD1, login: string, day?: number): number {
  const d = day ?? Math.floor(Date.now() / 86_400_000);
  const row = d1.rows("SELECT n FROM kv_write_budget WHERE day = ? AND login_hash = ?", d, login)[0];
  return Number(row?.n ?? 0);
}

/** SHA-256 hex of a session token, as the sessions table keys it. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A signed-in session straight in D1, like a sign-in makes it: the login is
 * marked migrated, so the KV record's legacy token list is not read.
 */
export function addSession(
  d1: FakeD1,
  login: string,
  token: string,
  createdAt = Date.now(),
): void {
  d1.raw
    .prepare("INSERT OR IGNORE INTO session_migrations (login_hash, migrated_at) VALUES (?, ?)")
    .run(login, createdAt);
  d1.raw
    .prepare("INSERT INTO sessions (login_hash, token_hash, created_at) VALUES (?, ?, ?)")
    .run(login, tokenHash(token), createdAt);
}

export class FakeKV {
  readonly data = new Map<string, string | ArrayBuffer>();
  readonly meta = new Map<string, unknown>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  /** When set, put() throws this (the daily limit, an outage). */
  putError: Error | null = null;
  /** Thrown by the next put() calls, one each, before putError is looked at. */
  readonly putErrors: Error[] = [];
  /** Every put() call, refused ones included. */
  putAttempts = 0;

  constructor(seed: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(seed)) {
      this.data.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }

  async get(
    key: string | string[],
    opts?: { type?: string } | string,
  ): Promise<unknown> {
    const type = typeof opts === "string" ? opts : opts?.type;
    const one = (k: string) => {
      const raw = this.data.get(k);
      if (raw === undefined) return null;
      if (type === "arrayBuffer") return typeof raw === "string" ? new TextEncoder().encode(raw).buffer : raw;
      if (type === "stream") return new Response(raw).body;
      if (typeof raw !== "string") return null;
      return type === "json" ? JSON.parse(raw) : raw;
    };
    // Bulk form, like KV: a Map with null for the keys that do not exist
    if (Array.isArray(key)) return new Map(key.map((k) => [k, one(k)]));
    return one(key);
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    opts?: { metadata?: unknown },
  ): Promise<void> {
    this.putAttempts++;
    const once = this.putErrors.shift();
    if (once) throw once;
    if (this.putError) throw this.putError;
    this.puts.push(key);
    const stored = ArrayBuffer.isView(value)
      ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      : value;
    this.data.set(key, stored as string | ArrayBuffer);
    if (opts?.metadata !== undefined) this.meta.set(key, opts.metadata);
    else this.meta.delete(key);
  }

  async getWithMetadata(key: string, opts?: { type?: string } | string) {
    return { value: await this.get(key, opts), metadata: this.meta.get(key) ?? null };
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.data.delete(key);
    this.meta.delete(key);
  }

  json(key: string): any {
    const raw = this.data.get(key);
    return typeof raw !== "string" ? undefined : JSON.parse(raw);
  }
}

/**
 * Stand-in for a Workers rate limit binding: counts calls per key and refuses
 * past `limit`, or refuses everything when `denyAll` is set.
 */
export class FakeRateLimit {
  readonly calls: string[] = [];
  denyAll = false;

  constructor(readonly max = Infinity) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.calls.push(key);
    if (this.denyAll) return { success: false };
    return { success: this.calls.filter((k) => k === key).length <= this.max };
  }
}

/**
 * A fetch() mock for a host that accepts the connection and never answers:
 * it only settles when the request's signal aborts, rejecting with the
 * signal's reason (a TimeoutError for AbortSignal.timeout), like a real
 * fetch. Without a signal it never settles, so a missing deadline shows as a
 * test that times out. Records each URL in `calls`.
 */
export function hangingFetch(calls: string[] = []) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

/**
 * A 200 whose body sends `head` and then stalls until the request's signal
 * aborts, when it errors like a real fetch body does.
 */
export function stalledBody(
  init: RequestInit | undefined,
  head = "partial",
  headers: Record<string, string> = {},
): Response {
  const signal = init?.signal;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(stream, { status: 200, headers });
}

export function makeEnv(
  opts: { kv?: FakeKV; d1?: FakeD1; vars?: Partial<Env> } = {},
): { env: Env; kv: FakeKV; d1: FakeD1 } {
  const kv = opts.kv ?? new FakeKV();
  const d1 = opts.d1 ?? new FakeD1();
  const env = {
    BETTER_INTRA_KV: kv,
    better_intra_d1: d1,
    ...opts.vars,
  } as unknown as Env;
  return { env, kv, d1 };
}
