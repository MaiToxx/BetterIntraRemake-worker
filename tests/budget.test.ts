import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import {
  BUDGET_ALL,
  DAILY_KV_WRITES,
  DAILY_KV_WRITES_PER_LOGIN,
  DAILY_KV_WRITES_SIGN_IN,
  budgetRes,
  spendKvWrite,
  utcDay,
} from "../src/budget";
import { resetRateLimits } from "../src/rate-limit";
import type { Env } from "../src/types";
import { FakeD1, FakeKV, budgetCount, makeEnv } from "./helpers/fake-env";
import { readFixture } from "./helpers/fixtures";

const LOGIN = "7".repeat(64);
const OTHER = "8".repeat(64);
const SESSION = "session-budget";
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const DAY = utcDay(NOW);

/** Sets today's count of `who` (a login hash or '*'). */
function setCount(d1: FakeD1, who: string, n: number, day = DAY): void {
  d1.raw
    .prepare("INSERT OR REPLACE INTO kv_write_budget (day, login_hash, n) VALUES (?, ?, ?)")
    .run(day, who, n);
}

const allRows = (d1: FakeD1) =>
  d1.rows("SELECT day, login_hash, n FROM kv_write_budget ORDER BY day, login_hash");

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetRateLimits();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("spendKvWrite", () => {
  it("counts each write for the login and for the whole namespace", async () => {
    const { env, d1 } = makeEnv();
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    expect(await spendKvWrite(env, OTHER)).toBe(true);
    expect(budgetCount(d1, LOGIN)).toBe(2);
    expect(budgetCount(d1, OTHER)).toBe(1);
    expect(budgetCount(d1, BUDGET_ALL)).toBe(3);
  });

  it("refuses a login at its cap without writing anything, and leaves the others alone", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN - 1);
    setCount(d1, BUDGET_ALL, 500);
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    const before = allRows(d1);
    expect(await spendKvWrite(env, LOGIN)).toBe(false);
    expect(await spendKvWrite(env, LOGIN)).toBe(false);
    // a refusal is free: no row written, the namespace count untouched
    expect(allRows(d1)).toEqual(before);
    expect(await spendKvWrite(env, OTHER)).toBe(true);
    expect(budgetCount(d1, BUDGET_ALL)).toBe(502);
  });

  it("refuses everyone once the namespace is at its cap, without writing", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES);
    expect(await spendKvWrite(env, LOGIN)).toBe(false);
    expect(allRows(d1)).toEqual([{ day: DAY, login_hash: BUDGET_ALL, n: DAILY_KV_WRITES }]);
  });

  it("counts both rows or neither at the very edge of both caps", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN - 1);
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES - 1);
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    expect(budgetCount(d1, LOGIN)).toBe(DAILY_KV_WRITES_PER_LOGIN);
    expect(budgetCount(d1, BUDGET_ALL)).toBe(DAILY_KV_WRITES);
    expect(await spendKvWrite(env, OTHER)).toBe(false);
    expect(budgetCount(d1, OTHER)).toBe(0);
  });

  it("lets a sign-in go past the push cap, up to its own", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES);
    expect(await spendKvWrite(env, LOGIN, { globalCap: DAILY_KV_WRITES_SIGN_IN })).toBe(true);
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES_SIGN_IN);
    expect(await spendKvWrite(env, OTHER, { globalCap: DAILY_KV_WRITES_SIGN_IN })).toBe(false);
  });

  it("starts afresh each UTC day and prunes what is older than yesterday", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN, DAY - 1);
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES, DAY - 1);
    setCount(d1, LOGIN, 5, DAY - 2);
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    expect(allRows(d1)).toEqual([
      { day: DAY - 1, login_hash: BUDGET_ALL, n: DAILY_KV_WRITES },
      { day: DAY - 1, login_hash: LOGIN, n: DAILY_KV_WRITES_PER_LOGIN },
      { day: DAY, login_hash: BUDGET_ALL, n: 1 },
      { day: DAY, login_hash: LOGIN, n: 1 },
    ]);
  });

  it("allows the write, and says so, when D1 fails", async () => {
    const { env, d1 } = makeEnv();
    d1.raw.exec("DROP TABLE kv_write_budget");
    expect(await spendKvWrite(env, LOGIN)).toBe(true);
    expect(String(warn.mock.calls[0][0])).toContain("[budget] count failed, write allowed");
  });

  it("names the login (shortened) and both counts when it refuses", async () => {
    const { env, d1 } = makeEnv();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN);
    setCount(d1, BUDGET_ALL, 321);
    await spendKvWrite(env, LOGIN);
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toContain(LOGIN.slice(0, 12));
    expect(line).not.toContain(LOGIN);
    expect(line).toContain(`login ${DAILY_KV_WRITES_PER_LOGIN}/${DAILY_KV_WRITES_PER_LOGIN}, all 321`);
  });
});

describe("budgetRes", () => {
  it("is a CORS-readable JSON 503 with the seconds left until 00:00 UTC", async () => {
    const res = budgetRes(NOW);
    expect(res.status).toBe(503);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Retry-After")).toBe(String(12 * 3600));
    expect(await res.json()).toEqual({
      error: "daily_write_budget",
      message: expect.stringContaining("00:00 UTC"),
    });
  });
});

// ---------------------------------------------------------------------------
// The routes that write KV
// ---------------------------------------------------------------------------

function seeded(vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({ [LOGIN]: { sessionTokens: [SESSION], settings: { A: 1 } } }),
    vars,
  });
}

const api = (env: Env, path: string, init: RequestInit = {}) =>
  worker.fetch(
    new Request(`https://w.test${path}${path.includes("?") ? "&" : "?"}login=${LOGIN}`, {
      ...init,
      headers: { Authorization: `Bearer ${SESSION}`, ...(init.headers ?? {}) },
    }),
    env,
  );

const push = (env: Env, settings: Record<string, unknown>) =>
  api(env, "/api/v1/private/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });

describe("the daily budget on the routes", () => {
  it("counts a settings push that writes, never one that changes nothing", async () => {
    const { env, d1 } = seeded();
    expect((await push(env, { A: 1 })).status).toBe(200);
    expect(budgetCount(d1, LOGIN)).toBe(0);
    expect((await push(env, { A: 2 })).status).toBe(200);
    expect(budgetCount(d1, LOGIN)).toBe(1);
  });

  it("refuses a push past the cap with 503 daily_write_budget and no KV write", async () => {
    const { env, kv, d1 } = seeded();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN);
    const res = await push(env, { A: 2 });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("daily_write_budget");
    expect(kv.puts).toEqual([]);
    expect(kv.json(LOGIN).settings).toEqual({ A: 1 });
  });

  it("refuses an image upload past the cap, after checking the file, without a KV write", async () => {
    const { env, kv, d1 } = seeded();
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES);
    // a file that is not an image is refused for that, and spends nothing
    const junk = await api(env, "/api/v1/private/images?slot=avatar", {
      method: "POST",
      body: "not an image at all",
    });
    expect(junk.status).toBe(415);
    const res = await api(env, "/api/v1/private/images?slot=avatar", {
      method: "POST",
      body: readFixture("gps.png"),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("daily_write_budget");
    expect(kv.puts).toEqual([]);
  });

  it("never refuses a sign-out, an image delete or a wipe", async () => {
    const { env, kv, d1 } = seeded();
    setCount(d1, LOGIN, DAILY_KV_WRITES_PER_LOGIN);
    setCount(d1, BUDGET_ALL, DAILY_KV_WRITES_SIGN_IN);
    kv.data.set(`img:${LOGIN}:avatar`, "x");
    expect((await api(env, "/api/v1/private/images?slot=avatar", { method: "DELETE" })).status).toBe(204);
    expect((await api(env, "/api/v1/private/settings?all=true", { method: "DELETE" })).status).toBe(200);
    expect(kv.data.has(LOGIN)).toBe(false);
    // the day's count stays: a wipe must not reset the cap
    expect(budgetCount(d1, LOGIN)).toBe(DAILY_KV_WRITES_PER_LOGIN);
  });
});
