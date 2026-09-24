import { describe, it, expect, beforeEach } from "vitest";
import { handleStats, resetStatsCache, STATS_CACHE_MS } from "../src/handlers/stats";
import { Env } from "../src/types";
import { FakeD1 } from "./helpers/fake-env";

const NOW_MS = Date.UTC(2026, 8, 24, 15, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);
const DAY = 24 * 60 * 60;

let d1: FakeD1;
let env: Env;

function addUser(hash: string, createdAt: number, country: string | null = null) {
  d1.raw.prepare("INSERT INTO users (hash, country, created_at) VALUES (?, ?, ?)").run(hash, country, createdAt);
}

async function stats(now = NOW_MS) {
  const res = await handleStats(new Request("https://x/stats"), env, now);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetStatsCache();
  d1 = new FakeD1();
  env = { better_intra_d1: d1 as any, BETTER_INTRA_KV: {} as any } as Env;
});

describe("handleStats", () => {
  it("returns 405 for non-GET methods", async () => {
    const res = await handleStats(new Request("https://x/stats", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(405);
  });

  it("returns zeroes when the users table is empty", async () => {
    expect(await stats()).toEqual({
      total: 0,
      newToday: 0,
      newLast30Days: 0,
      newLast14Days: 0,
      newLast7Days: 0,
      countries: [],
    });
  });

  it("splits the window counts by age, and never serves a country", async () => {
    addUser("a", NOW - 100, "BE"); // today (15:00 UTC, so 100 s ago is today)
    addUser("b", NOW - 1 * DAY);
    addUser("c", NOW - 10 * DAY, "FR");
    addUser("d", NOW - 20 * DAY);
    addUser("e", NOW - 40 * DAY);
    expect(await stats()).toEqual({
      total: 5,
      newToday: 1,
      newLast30Days: 4,
      newLast14Days: 3,
      newLast7Days: 2,
      countries: [],
    });
  });

  it("reads the table once per 10 minutes, in one query", async () => {
    addUser("a", NOW - 100);
    await stats();
    expect(d1.prepared).toHaveLength(1);
    addUser("b", NOW - 50);
    expect((await stats(NOW_MS + 60_000)).total).toBe(1);
    expect(d1.prepared).toHaveLength(1);
    expect((await stats(NOW_MS + STATS_CACHE_MS)).total).toBe(2);
    expect(d1.prepared).toHaveLength(2);
  });
});
