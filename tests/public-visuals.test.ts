import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import {
  PUBLIC_VISUAL_KEYS,
  publicSubset,
  publicVisuals,
} from "../src/handlers/settings";
import { resetRateLimits } from "../src/rate-limit";
import type { Env } from "../src/types";
import { KV_RETRY } from "../src/utils";
import { FakeD1, FakeKV, kvRateLimitError, makeEnv } from "./helpers/fake-env";

const LOGIN = "3".repeat(64);
const OTHER = "2".repeat(64);
const UNKNOWN = "1".repeat(64);
const SESSION = "session-public";

/** Values of every shape a record may hold, sane or not. */
const SHAPES: unknown[] = [
  "",
  "x",
  "#123456",
  "https://img.test/a.png",
  "a".repeat(64),
  "a".repeat(65),
  "a".repeat(512),
  "a".repeat(513),
  "https://x/" + "u".repeat(2038),
  "https://x/" + "u".repeat(2039),
  "a".repeat(70_000),
  "120",
  " 42 ",
  "NaN",
  0,
  -0,
  12.5,
  true,
  false,
  null,
  [],
  [5],
  ["7"],
  {},
  { a: "b" },
  { big: "c".repeat(3000) },
];

/** A deterministic mix: key i gets shape (i * step + offset) % SHAPES.length. */
function mixedSettings(step: number, offset: number): Record<string, unknown> {
  const settings: Record<string, unknown> = { CUSTOM_CSS: "body{}", FRIENDS_LIST: ["a"] };
  PUBLIC_VISUAL_KEYS.forEach((key, i) => {
    settings[key] = SHAPES[(i * step + offset) % SHAPES.length];
  });
  return settings;
}

describe("publicSubset", () => {
  it("renders exactly like the whole settings, byte for byte, whatever the values", () => {
    const cases: Record<string, unknown>[] = [{}];
    for (let step = 1; step <= 7; step++) {
      for (let offset = 0; offset < SHAPES.length; offset++) cases.push(mixedSettings(step, offset));
    }
    // the look and the extras switched on, then off
    for (const c of cases.slice()) {
      cases.push({ ...c, CUSTOM_SHARE_LOOK: true, PROFILE_PUB_ENABLED: true });
      cases.push({ ...c, CUSTOM_SHARE_LOOK: false, PROFILE_PUB_ENABLED: false });
    }
    for (const settings of cases) {
      const whole = JSON.stringify(publicVisuals({ settings }));
      // as the row stores it: JSON, then parsed back
      const stored = JSON.parse(JSON.stringify(publicSubset(settings)));
      expect(JSON.stringify(publicVisuals({ settings: stored }))).toBe(whole);
    }
  });

  it("holds every key publicVisuals reads", () => {
    const read = new Set<string>();
    const settings = new Proxy({} as Record<string, unknown>, {
      get(_t, key) {
        if (typeof key === "string") read.add(key);
        return undefined;
      },
    });
    publicVisuals({ settings });
    // with the look on, the look keys are read too
    publicVisuals({
      settings: new Proxy({ CUSTOM_SHARE_LOOK: true } as Record<string, unknown>, {
        get(t, key) {
          if (typeof key === "string") read.add(key);
          return t[key as string];
        },
      }),
    });
    for (const key of read) expect(PUBLIC_VISUAL_KEYS).toContain(key);
  });

  it("keeps nothing private and stays small whatever the record holds", () => {
    const subset = publicSubset({
      ...mixedSettings(1, 10),
      CUSTOM_CSS: "secret css",
      CLOUD_TOKEN: "t",
      CALENDAR_SYNC_TOKEN: "c",
      LOGTIME_EMOJI_RATE: 13.5,
      PROFILE_IMAGE_HISTORY: ["https://old"],
    });
    for (const key of Object.keys(subset)) expect(PUBLIC_VISUAL_KEYS).toContain(key);
    expect(JSON.stringify(subset).length).toBeLessThan(40 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function setup() {
  return makeEnv({
    kv: new FakeKV({
      [LOGIN]: { sessionTokens: [SESSION], settings: { PROFILE_IMAGE_URL: "https://img.test/kv.png" } },
      [OTHER]: { settings: { PROFILE_IMAGE_URL: "https://img.test/other.png", CUSTOM_SHARE_LOOK: true, CUSTOM_RADIUS: 8 } },
    }),
  });
}

const push = (env: Env, settings: Record<string, unknown>) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SESSION}`, "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    }),
    env,
  );

const single = (env: Env, login = LOGIN) =>
  worker.fetch(new Request(`https://w.test/api/v1/public/visuals?login=${login}`), env);

const batch = (env: Env, logins: string[]) =>
  worker.fetch(new Request(`https://w.test/api/v1/public/visuals?logins=${logins.join(",")}`), env);

const rows = (d1: FakeD1) => d1.rows("SELECT hash, settings FROM public_visuals ORDER BY hash");

beforeEach(() => {
  resetRateLimits();
  KV_RETRY.delayMs = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  KV_RETRY.delayMs = 1100;
});

describe("public_visuals rows", () => {
  it("are written by a push that changes what visitors see, and only then", async () => {
    const { env, d1 } = setup();
    // private keys only: no row
    expect((await push(env, { CUSTOM_CSS: "a{}", FRIENDS_LIST: ["x"] })).status).toBe(200);
    expect(rows(d1)).toEqual([]);
    // the avatar: the row holds the whole public subset of the merged settings
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" })).status).toBe(200);
    expect(rows(d1)).toEqual([
      { hash: LOGIN, settings: JSON.stringify({ PROFILE_IMAGE_URL: "https://img.test/new.png" }) },
    ]);
    const writes = () => d1.prepared.filter((sql) => /INSERT INTO public_visuals/.test(sql)).length;
    const before = writes();
    // a private change, or no change at all, leaves the row alone
    await push(env, { CUSTOM_CSS: "b{}" });
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" });
    expect(writes()).toBe(before);
    await push(env, { CUSTOM_SHARE_LOOK: true, CUSTOM_RADIUS: 12 });
    expect(writes()).toBe(before + 1);
  });

  it("are brought back in step by a push that read a stale copy of the record", async () => {
    const { env, kv, d1 } = setup();
    const before = kv.data.get(LOGIN) as string;
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" });
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_IMAGE_URL: "https://img.test/new.png" });
    // a location still serving the record from before that push, where the
    // student goes back to the old avatar along with a private change: next
    // to that copy the public part changes nothing, but the row said otherwise
    kv.data.set(LOGIN, before);
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/kv.png", CUSTOM_CSS: "a{}" })).status).toBe(200);
    expect(kv.json(LOGIN).settings.PROFILE_IMAGE_URL).toBe("https://img.test/kv.png");
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_IMAGE_URL: "https://img.test/kv.png" });
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("https://img.test/kv.png");
    // a row already in step is left alone (no write, same date)
    const stamp = () => d1.rows("SELECT updated_at FROM public_visuals")[0].updated_at;
    const at = stamp();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await push(env, { CUSTOM_CSS: "b{}" })).status).toBe(200);
    expect(stamp()).toBe(at);
  });

  it("are not created by that check, nor fail the push when it cannot run", async () => {
    const { env, kv, d1 } = setup();
    // no row yet: a private push creates none
    expect((await push(env, { CUSTOM_CSS: "a{}" })).status).toBe(200);
    expect(rows(d1)).toEqual([]);
    // D1 refusing the comparison: the push still lands (logged)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    d1.raw.exec("ALTER TABLE public_visuals RENAME TO pv_gone");
    expect((await push(env, { CUSTOM_CSS: "b{}" })).status).toBe(200);
    expect(kv.json(LOGIN).settings.CUSTOM_CSS).toBe("b{}");
    expect(warn.mock.calls.some(([m]) => String(m).includes("[public-visuals]"))).toBe(true);
    d1.raw.exec("ALTER TABLE pv_gone RENAME TO public_visuals");
  });

  it("serve the single route without a KV read once the login has one", async () => {
    const { env, kv } = setup();
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" });
    const getSpy = vi.spyOn(kv, "get");
    const res = await single(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(((await res.json()) as { avatar: string }).avatar).toBe("https://img.test/new.png");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("answer the same bytes as the KV record would", async () => {
    // what a push accepts: no string past 64 KB
    const mixed: Record<string, unknown> = {
      ...mixedSettings(3, 4),
      CUSTOM_SHARE_LOOK: true,
      PROFILE_PUB_ENABLED: true,
    };
    const settings = Object.fromEntries(
      Object.entries(mixed).filter(([, v]) => !(typeof v === "string" && v.length > 64 * 1024)),
    );
    const fromKv = makeEnv({ kv: new FakeKV({ [LOGIN]: { settings } }) });
    const fromD1 = setup();
    // the same settings, written through a push
    await push(fromD1.env, settings);
    expect(rows(fromD1.d1)).toHaveLength(1);
    const a = await (await single(fromKv.env)).text();
    const b = await (await single(fromD1.env)).text();
    expect(b).toBe(a);
    const ba = await (await batch(fromKv.env, [LOGIN])).text();
    const bb = await (await batch(fromD1.env, [LOGIN])).text();
    expect(bb).toBe(ba);
  });

  it("leave the logins without a row to KV, in one bulk read for those only", async () => {
    const { env, kv } = setup();
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" });
    const getSpy = vi.spyOn(kv, "get");
    const res = await batch(env, [LOGIN, OTHER, UNKNOWN]);
    const { visuals } = (await res.json()) as { visuals: Record<string, { avatar: string; look: unknown }> };
    expect(Object.keys(visuals)).toEqual([LOGIN, OTHER, UNKNOWN]);
    expect(visuals[LOGIN].avatar).toBe("https://img.test/new.png");
    expect(visuals[OTHER].avatar).toBe("https://img.test/other.png");
    expect(visuals[OTHER].look).toEqual({ CUSTOM_RADIUS: 8 });
    expect(visuals[UNKNOWN].avatar).toBe("");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toEqual([OTHER, UNKNOWN]);
    // every login with a row: no KV read at all
    getSpy.mockClear();
    expect((await batch(env, [LOGIN])).status).toBe(200);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("go with Wipe all data, and the profile shows the defaults again", async () => {
    const { env, d1 } = setup();
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" });
    const wipe = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}&all=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SESSION}` },
      }),
      env,
    );
    expect(wipe.status).toBe(200);
    expect(rows(d1)).toEqual([]);
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("");
  });

  it("fall back to KV when D1 cannot be read", async () => {
    const { env, d1 } = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    d1.raw.exec("DROP TABLE public_visuals");
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("https://img.test/kv.png");
    const { visuals } = (await (await batch(env, [OTHER])).json()) as { visuals: Record<string, { avatar: string }> };
    expect(visuals[OTHER].avatar).toBe("https://img.test/other.png");
  });

  it("are written before the record: a D1 failure writes nothing, and the push can be retried", async () => {
    const { env, kv, d1 } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    d1.raw.exec("ALTER TABLE public_visuals RENAME TO pv_gone");
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" })).status).toBe(500);
    expect(kv.puts).toEqual([]);
    d1.raw.exec("ALTER TABLE pv_gone RENAME TO public_visuals");
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/new.png" })).status).toBe(200);
    expect(rows(d1)).toHaveLength(1);
  });

  it("follow the record a KV retry ends with", async () => {
    const { env, kv, d1 } = setup();
    const put = kv.put.bind(kv);
    let first = true;
    kv.put = async (key, value, opts) => {
      if (first) {
        first = false;
        // another browser pushed the very avatar in between, with a banner
        kv.data.set(
          LOGIN,
          JSON.stringify({
            settings: { PROFILE_IMAGE_URL: "https://img.test/theirs.png", PROFILE_BANNER_URL: "https://img.test/b.png" },
          }),
        );
        throw kvRateLimitError();
      }
      return put(key, value, opts);
    };
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/theirs.png" })).status).toBe(200);
    // our first attempt wrote our subset (no banner); the retry found the
    // same avatar stored, wrote no record, and put the row back in step
    expect(kv.puts).toEqual([]);
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({
      PROFILE_IMAGE_URL: "https://img.test/theirs.png",
      PROFILE_BANNER_URL: "https://img.test/b.png",
    });
  });

  it("are put back in step when the retry ends in a conflict", async () => {
    const { env, kv, d1 } = setup();
    kv.data.set(LOGIN, JSON.stringify({ sessionTokens: [SESSION], settings: { PROFILE_IMAGE_URL: "https://img.test/kv.png" }, settingsRev: 10 }));
    const put = kv.put.bind(kv);
    let first = true;
    kv.put = async (key, value, opts) => {
      if (first) {
        first = false;
        // another browser pushed a banner in between: our retry is behind
        kv.data.set(LOGIN, JSON.stringify({ settings: { PROFILE_BANNER_URL: "https://img.test/b.png" }, settingsRev: 20 }));
        throw kvRateLimitError();
      }
      return put(key, value, opts);
    };
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SESSION}`, "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { PROFILE_IMAGE_URL: "https://img.test/mine.png" }, baseRev: 10 }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    // the row our first attempt wrote now matches the record that stays
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_BANNER_URL: "https://img.test/b.png" });
  });

  it("are put back when KV refuses the record twice (kv_busy)", async () => {
    const { env, kv, d1 } = setup();
    // an earlier push left a row that matches the record
    await push(env, { PROFILE_IMAGE_URL: "https://img.test/kv2.png" });
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_IMAGE_URL: "https://img.test/kv2.png" });
    kv.putErrors.push(kvRateLimitError(), kvRateLimitError());
    const res = await push(env, { PROFILE_IMAGE_URL: "https://img.test/never-stored.png" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("kv_busy");
    // the record kept the old avatar: so does what visitors are served
    expect(kv.json(LOGIN).settings.PROFILE_IMAGE_URL).toBe("https://img.test/kv2.png");
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_IMAGE_URL: "https://img.test/kv2.png" });
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("https://img.test/kv2.png");
    // going back to the stored avatar changes nothing next to the record:
    // the row must not be left on the look that was never stored
    expect((await push(env, { PROFILE_IMAGE_URL: "https://img.test/kv2.png" })).status).toBe(200);
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("https://img.test/kv2.png");
  });

  it("are put back when the put throws for good (KV's daily limit), and the push stays a 500", async () => {
    const { env, kv, d1 } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    kv.putError = new Error("KV put() limit exceeded for the day.");
    const res = await push(env, { PROFILE_IMAGE_URL: "https://img.test/never-stored.png" });
    expect(res.status).toBe(500);
    // the login had no row: the one this push wrote now matches the record
    expect(JSON.parse(String(rows(d1)[0].settings))).toEqual({ PROFILE_IMAGE_URL: "https://img.test/kv.png" });
    expect(((await (await single(env)).json()) as { avatar: string }).avatar).toBe("https://img.test/kv.png");
  });
});
