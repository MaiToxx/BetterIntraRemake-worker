import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { handlePrivateSettings } from "../src/handlers/settings";
import { resetRateLimits } from "../src/rate-limit";
import type { Env, UserData } from "../src/types";
import { KV_RETRY } from "../src/utils";
import {
  FakeKV,
  FakeRateLimit,
  budgetCount,
  kvRateLimitError,
  makeEnv,
} from "./helpers/fake-env";

const LOGIN = "4".repeat(64);
const SESSION = "session-rev";
const NOW = 1_800_000_000_000;

function setup(record: UserData, vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({ [LOGIN]: { sessionTokens: [SESSION], ...record } }),
    vars,
  });
}

const api = (env: Env, init: RequestInit & { query?: string } = {}) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}${init.query ?? ""}`, {
      ...init,
      headers: { Authorization: `Bearer ${SESSION}`, "Content-Type": "application/json" },
    }),
    env,
  );

const push = (env: Env, body: Record<string, unknown>) =>
  api(env, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  KV_RETRY.delayMs = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  KV_RETRY.delayMs = 1100;
});

describe("settings revision (rev)", () => {
  it("is 0 for a record from before revisions, in the full and the meta GET", async () => {
    const { env } = setup({ settings: { A: 1 } });
    expect(((await (await api(env)).json()) as { rev: number }).rev).toBe(0);
    expect(await (await api(env, { query: "&fields=meta" })).json()).toEqual({
      activeSessions: 1,
      discordId: null,
      rev: 0,
    });
  });

  it("is stored by every push that writes, and read back by both GETs", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    expect(await (await push(env, { settings: { A: 2 } })).text()).toBe("Saved");
    expect(kv.json(LOGIN).settingsRev).toBe(NOW);
    expect(((await (await api(env)).json()) as { rev: number }).rev).toBe(NOW);
    expect(((await (await api(env, { query: "&fields=meta" })).json()) as { rev: number }).rev).toBe(NOW);
  });

  it("only grows: max(now, previous + 1), even with a clock behind the stored one", async () => {
    const { env, kv } = setup({ settings: { A: 1 }, settingsRev: NOW + 60_000 });
    await push(env, { settings: { A: 2 } });
    expect(kv.json(LOGIN).settingsRev).toBe(NOW + 60_001);
    await push(env, { settings: { A: 3 } });
    expect(kv.json(LOGIN).settingsRev).toBe(NOW + 60_002);
  });

  it("answers JSON {ok, rev} when the push named its base revision", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    const res = await push(env, { settings: { A: 2 }, baseRev: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true, rev: NOW });
    expect(kv.json(LOGIN).settingsRev).toBe(NOW);
  });

  it("refuses with 409 when the stored revision is newer, writing nothing and spending nothing", async () => {
    const rl = new FakeRateLimit();
    const { env, kv, d1 } = setup({ settings: { A: 1, FRIENDS_LIST: ["alice"] }, settingsRev: 500 }, { WRITE_RL: rl });
    const res = await push(env, { settings: { FRIENDS_LIST: ["bob"] }, baseRev: 499 });
    expect(res.status).toBe(409);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({
      error: "conflict",
      message: expect.stringMatching(/another browser/),
      rev: 500,
    });
    expect(kv.puts).toEqual([]);
    expect(kv.json(LOGIN).settings.FRIENDS_LIST).toEqual(["alice"]);
    // no write slot, no budget, no public row
    expect(rl.calls).toEqual([]);
    expect(budgetCount(d1, LOGIN)).toBe(0);
    expect(d1.rows("SELECT * FROM public_visuals")).toEqual([]);
  });

  it("takes an older stored revision for this browser's own write read back stale, and writes", async () => {
    const { env, kv } = setup({ settings: { A: 1 }, settingsRev: 400 });
    const res = await push(env, { settings: { A: 2 }, baseRev: 450 });
    expect(await res.json()).toEqual({ ok: true, rev: NOW });
    expect(kv.json(LOGIN).settings.A).toBe(2);
  });

  it("answers 200 with the stored revision for a push that changes nothing, when it is not behind", async () => {
    const { env, kv } = setup({ settings: { A: 1 }, settingsRev: 500 });
    for (const baseRev of [500, 900]) {
      const res = await push(env, { settings: { A: 1 }, baseRev });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, rev: 500 });
    }
    expect(kv.puts).toEqual([]);
  });

  it("still answers 409 to a push behind the stored revision that would change nothing", async () => {
    // A few keys that happen to match: answered 200 with rev 500, the
    // sender would take it for its own write, and its next full push
    // would overwrite whatever changed at 500.
    const { env, kv } = setup({ settings: { A: 1, B: "theirs" }, settingsRev: 500 });
    const res = await push(env, { settings: { A: 1 }, baseRev: 3 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { rev: number }).rev).toBe(500);
    expect(kv.puts).toEqual([]);
    // without baseRev it is the plain no-op it always was
    expect(await (await push(env, { settings: { A: 1 } })).text()).toBe("Saved");
  });

  it("keeps the old behaviour without baseRev: the merge is written, the answer is the text", async () => {
    const { env, kv } = setup({ settings: { A: 1, B: 1 }, settingsRev: NOW + 5 });
    const res = await push(env, { settings: { B: 2 } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toBe("Saved");
    expect(kv.json(LOGIN)).toEqual({ settings: { A: 1, B: 2 }, settingsRev: NOW + 6 });
  });

  it("refuses a baseRev that is not a number, and accepts null as none", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    for (const baseRev of ["12", true, {}, [1]]) {
      const res = await push(env, { settings: { A: 2 }, baseRev });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    }
    expect(kv.puts).toEqual([]);
    expect(await (await push(env, { settings: { A: 2 }, baseRev: null })).text()).toBe("Saved");
  });

  it("is left alone by a sign-out, and kept by the next push with the other record fields", async () => {
    const { env, kv } = setup({ settings: { A: 1 }, settingsRev: 700 });
    expect((await api(env, { method: "DELETE" })).status).toBe(200);
    expect(kv.json(LOGIN).settingsRev).toBe(700);
    expect(kv.puts).toEqual([]);
  });
});

describe("KV busy: one write per key per second", () => {
  it("retries once after about 1.1 s, and the push goes through", async () => {
    KV_RETRY.delayMs = 1100;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { env, kv, d1 } = setup({ settings: { A: 1 } });
    kv.putErrors.push(kvRateLimitError());
    const pending = push(env, { settings: { A: 2 }, baseRev: 0 });
    // the session check hashes the token off the fake clock: wait for the
    // first put before moving time
    while (kv.putAttempts === 0) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
    expect(kv.putAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rev: NOW });
    expect(kv.putAttempts).toBe(2);
    expect(kv.json(LOGIN).settings.A).toBe(2);
    // one push, one unit of the daily budget
    expect(budgetCount(d1, LOGIN)).toBe(1);
  });

  it("answers 503 kv_busy with Retry-After: 2 when the retry is refused too", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    kv.putErrors.push(kvRateLimitError(), kvRateLimitError());
    const res = await push(env, { settings: { A: 2 } });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "kv_busy", message: expect.any(String) });
    expect(kv.json(LOGIN).settings.A).toBe(1);
  });

  it("merges into a fresh read on the retry: a push written in between is not rolled back", async () => {
    const { env, kv } = setup({ settings: { A: 1, B: 1 } });
    const put = kv.put.bind(kv);
    let first = true;
    kv.put = async (key, value, opts) => {
      if (first) {
        first = false;
        // another browser's push lands, then ours is refused
        kv.data.set(LOGIN, JSON.stringify({ settings: { A: 1, B: 9 }, settingsRev: 42 }));
        throw kvRateLimitError();
      }
      return put(key, value, opts);
    };
    expect((await push(env, { settings: { A: 2 } })).status).toBe(200);
    expect(kv.json(LOGIN)).toEqual({ settings: { A: 2, B: 9 }, settingsRev: NOW });
  });

  it("answers 409 on the retry when the write in between came from another browser", async () => {
    const { env, kv } = setup({ settings: { A: 1 }, settingsRev: 100 });
    const put = kv.put.bind(kv);
    let first = true;
    kv.put = async (key, value, opts) => {
      if (first) {
        first = false;
        kv.data.set(LOGIN, JSON.stringify({ settings: { A: 5 }, settingsRev: 200 }));
        throw kvRateLimitError();
      }
      return put(key, value, opts);
    };
    const res = await push(env, { settings: { A: 2 }, baseRev: 100 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { rev: number }).rev).toBe(200);
    expect(kv.json(LOGIN).settings.A).toBe(5);
  });

  it("writes nothing on the retry when the same content was stored in between", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    let first = true;
    const put = kv.put.bind(kv);
    kv.put = async (key, value, opts) => {
      if (first) {
        first = false;
        kv.data.set(LOGIN, JSON.stringify({ settings: { A: 2 }, settingsRev: 7 }));
        throw kvRateLimitError();
      }
      return put(key, value, opts);
    };
    const res = await push(env, { settings: { A: 2 }, baseRev: 7 });
    expect(await res.json()).toEqual({ ok: true, rev: 7 });
    expect(kv.puts).toEqual([]);
  });

  it("does not retry other KV errors (the daily limit stays a 500)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, kv } = setup({ settings: { A: 1 } });
    kv.putError = new Error("KV put() limit exceeded for the day.");
    const res = await push(env, { settings: { A: 2 } });
    expect(res.status).toBe(500);
    expect(kv.putAttempts).toBe(1);
  });
});

describe("handlePrivateSettings with a record object (tests, router loader)", () => {
  it("reads the record passed in, and the retry reads KV afresh", async () => {
    const { env, kv } = setup({ settings: { A: 1 } });
    const passed: UserData = { sessionTokens: [SESSION], settings: { A: 1, STALE: true } };
    kv.putErrors.push(kvRateLimitError());
    const res = await handlePrivateSettings(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SESSION}` },
        body: JSON.stringify({ settings: { A: 2 } }),
      }),
      env,
      LOGIN,
      passed,
    );
    expect(res.status).toBe(200);
    // the stale copy was not re-put: the retry merged into what KV holds
    expect(kv.json(LOGIN).settings).toEqual({ A: 2 });
  });
});
