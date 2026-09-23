/**
 * In-memory stand-ins for the worker's bindings.
 *
 * FakeD1 runs the SQL on a real SQLite (node:sqlite), with schema.sql applied,
 * so constraints, JOINs and batches behave like D1 instead of like a mock that
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
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: URL, encoding: "utf8"): string;
};

const SCHEMA = readFileSync(
  new URL("../../schema.sql", (import.meta as { url?: string }).url),
  "utf8",
);

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
}

export class FakeD1 {
  readonly raw: SqliteDatabase;
  /** Every SQL text prepared, in order. */
  readonly prepared: string[] = [];

  constructor(opts: { schema?: boolean } = {}) {
    this.raw = new DatabaseSync(":memory:");
    if (opts.schema !== false) this.raw.exec(SCHEMA);
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
      for (const s of stmts) out.push(await s.run());
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

export class FakeKV {
  readonly data = new Map<string, string | ArrayBuffer>();
  readonly meta = new Map<string, unknown>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  /** When set, put() throws this (the daily limit, an outage). */
  putError: Error | null = null;

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
