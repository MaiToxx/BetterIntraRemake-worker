import { describe, it, expect } from "vitest";
import { FakeD1, MIGRATIONS } from "./helpers/fake-env";

// Loaded without an import so the worker's tsconfig (no Node types) is happy.
const nodeProcess = (globalThis as any).process;
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: URL, encoding: "utf8"): string;
};
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, (import.meta as { url?: string }).url), "utf8");

/** Tables and indexes of a database, as SQLite stored their definitions. */
function schemaOf(d1: FakeD1) {
  return d1
    .rows(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .map((r) => ({
      type: String(r.type),
      name: String(r.name),
      sql: String(r.sql).replace(/\s+/g, " ").trim(),
    }));
}

/** SQL statements of a file, comments left out. */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("migrations", () => {
  it("are numbered from 0001 without a gap, in the order wrangler applies them", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
    MIGRATIONS.forEach((m, i) => {
      expect(m.name).toMatch(new RegExp(`^${String(i + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    });
  });

  it("only ever add: CREATE ... IF NOT EXISTS or ADD COLUMN, nothing dropped or rewritten", () => {
    // The live database also holds upstream tables that nothing reads: they
    // are the operator's to drop by hand, never a migration's (`migrations
    // apply` runs every pending file, on every database).
    for (const m of MIGRATIONS) {
      for (const stmt of statements(m.sql)) {
        expect(stmt, m.name).toMatch(
          /^(CREATE (TABLE|INDEX|UNIQUE INDEX|VIEW|TRIGGER) IF NOT EXISTS |ALTER TABLE \S+ ADD COLUMN )/i,
        );
      }
    }
  });

  it("build the tables the worker queries, calendar_tokens and its index included", () => {
    const names = schemaOf(new FakeD1()).map((r) => `${r.type}:${r.name}`);
    for (const name of [
      "table:users",
      "table:subjects",
      "table:calendar_ics",
      "table:calendar_tokens",
      "index:calendar_tokens_login",
      "table:sessions",
      "table:session_migrations",
      "table:kv_write_budget",
      "table:public_visuals",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("are harmless on the live database: its extra tables, columns and rows stay", () => {
    const d1 = new FakeD1({ schema: false });
    // the shape the upstream schema left: more columns, more tables, rows
    d1.raw.exec(`
      CREATE TABLE users (hash TEXT PRIMARY KEY, country TEXT, forty_two_token TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE TABLE eval_users (login TEXT PRIMARY KEY);
      CREATE TABLE calendar_tokens (token TEXT PRIMARY KEY, login_hash TEXT NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
      INSERT INTO users (hash, country, forty_two_token) VALUES ('h', 'FR', 't');
      INSERT INTO eval_users (login) VALUES ('x');
      INSERT INTO calendar_tokens (token, login_hash) VALUES ('tok', 'h');
    `);
    for (const m of MIGRATIONS) d1.raw.exec(m.sql);
    expect(d1.rows("SELECT hash, country, forty_two_token FROM users")).toEqual([
      { hash: "h", country: "FR", forty_two_token: "t" },
    ]);
    expect(d1.rows("SELECT login FROM eval_users")).toEqual([{ login: "x" }]);
    expect(d1.rows("SELECT token FROM calendar_tokens")).toEqual([{ token: "tok" }]);
    expect(d1.rows("SELECT COUNT(*) AS n FROM sessions")).toEqual([{ n: 0 }]);
  });

  it("add up to schema.sql, the one-file schema of a fresh database", () => {
    const fromSchema = new FakeD1({ schema: false });
    fromSchema.raw.exec(read("schema.sql"));
    expect(schemaOf(fromSchema)).toEqual(schemaOf(new FakeD1()));
  });

  it("are where wrangler looks for them, and the client pin is configured", () => {
    const config = JSON.parse(read("wrangler.json"));
    expect(config.d1_databases).toEqual([
      expect.objectContaining({ binding: "better_intra_d1", migrations_dir: "migrations" }),
    ]);
    expect(config.vars?.JWT_ALLOWED_AZP).toBe("frontend-react");
  });
});
