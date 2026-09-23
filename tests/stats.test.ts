import { describe, it, expect, beforeEach } from "vitest";
import { handleStats } from "../src/handlers/stats";
import { Env } from "../src/types";

class MockD1 {
  rows: { country: string | null; created_at: number }[] = [];
  private bindArgs: any[] = [];

  prepare() {
    return this;
  }

  bind(...args: any[]) {
    this.bindArgs = args;
    return this;
  }

  async first() {
    if (this.bindArgs.length > 0) {
      const cutoff = this.bindArgs[0] as number;
      const count = this.rows.filter((r) => r.created_at > cutoff).length;
      return { c: count };
    }
    return { c: this.rows.length };
  }

  allCalls = 0;

  async all() {
    this.allCalls++;
    const counts = new Map<string, number>();
    for (const r of this.rows) {
      const key = r.country || "?";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const results = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([country, c]) => ({ country, c }));
    return { results };
  }
}

function makeEnv(d1: MockD1): Env {
  return { better_intra_d1: d1 as any, BETTER_INTRA_KV: {} as any } as Env;
}

const NOW = Math.floor(Date.now() / 1000);

describe("handleStats", () => {
  let d1: MockD1;
  let env: Env;

  beforeEach(() => {
    d1 = new MockD1();
    env = makeEnv(d1);
  });

  it("returns 405 for non-GET methods", async () => {
    const res = await handleStats(
      new Request("https://x/stats", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("returns zeroes when the users table is empty", async () => {
    const res = await handleStats(new Request("https://x/stats"), env);
    expect(await res.json()).toEqual({
      total: 0,
      newToday: 0,
      newLast30Days: 0,
      newLast14Days: 0,
      newLast7Days: 0,
      countries: [],
    });
  });

  it("counts all users and no longer breaks them down by country", async () => {
    d1.rows = [
      { country: "BE", created_at: NOW - 100 },
      { country: "BE", created_at: NOW - 200 },
      { country: "FR", created_at: NOW - 300 },
      { country: null, created_at: NOW - 400 },
    ];

    const res = await handleStats(new Request("https://x/stats"), env);
    const body = (await res.json()) as {
      total: number;
      newToday: number;
      newLast30Days: number;
      newLast14Days: number;
      newLast7Days: number;
      countries: { country: string; count: number }[];
    };
    expect(body.total).toBe(4);
    const dayStart = NOW - (NOW % 86_400);
    expect(body.newToday).toBe(
      d1.rows.filter((r) => r.created_at > dayStart).length,
    );
    expect(body.newLast30Days).toBe(4);
    expect(body.newLast14Days).toBe(4);
    expect(body.newLast7Days).toBe(4);
    // rows stored before the change may still hold a country: never served
    expect(body.countries).toEqual([]);
    expect(d1.allCalls).toBe(0);
  });

  it("splits the window counts by age", async () => {
    const d = (days: number) => NOW - days * 24 * 60 * 60;
    d1.rows = [
      { country: "BE", created_at: d(1) },
      { country: "FR", created_at: d(10) },
      { country: "US", created_at: d(20) },
      { country: "DE", created_at: d(40) },
    ];

    const res = await handleStats(new Request("https://x/stats"), env);
    const body = (await res.json()) as {
      total: number;
      newToday: number;
      newLast30Days: number;
      newLast14Days: number;
      newLast7Days: number;
      countries: { country: string; count: number }[];
    };
    expect(body.total).toBe(4);
    expect(body.newToday).toBe(0);
    expect(body.newLast30Days).toBe(3);
    expect(body.newLast14Days).toBe(2);
    expect(body.newLast7Days).toBe(1);
    expect(body.countries).toEqual([]);
  });
});
