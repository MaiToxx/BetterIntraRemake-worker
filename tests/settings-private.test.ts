import { describe, it, expect, beforeEach } from "vitest";
import {
  handlePrivateSettings,
  MAX_SETTING_STRING,
  MAX_SETTINGS_BYTES,
  type TooLargeBody,
} from "../src/handlers/settings";
import { LIMITS, resetRateLimits } from "../src/rate-limit";
import type { Env, UserData } from "../src/types";
import { FakeKV, FakeRateLimit, makeEnv } from "./helpers/fake-env";

const LOGIN = "c".repeat(64);
const OTHER = "9".repeat(64);
const SESSION = "session-c";

function setup(
  settings: Record<string, unknown> | undefined,
  vars: Partial<Env> = {},
) {
  const record: UserData = { sessionTokens: [SESSION, "session-c2"] };
  if (settings) record.settings = settings;
  return makeEnv({ kv: new FakeKV({ [LOGIN]: record }), vars });
}

async function existing(env: Env, login = LOGIN): Promise<UserData | null> {
  return (await env.BETTER_INTRA_KV.get(login, {
    type: "json",
  })) as UserData | null;
}

async function call(
  env: Env,
  init: RequestInit & { query?: string; login?: string; session?: string } = {},
): Promise<Response> {
  const login = init.login ?? LOGIN;
  const req = new Request(
    `https://w.test/api/v1/private/settings?login=${login}${init.query ?? ""}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${init.session ?? SESSION}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
  );
  return handlePrivateSettings(req, env, login, await existing(env, login));
}

async function push(
  env: Env,
  settings: unknown,
  session = SESSION,
): Promise<Response> {
  return call(env, {
    method: "POST",
    body: JSON.stringify({ settings }),
    session,
  });
}

beforeEach(() => {
  resetRateLimits();
});

describe("settings POST", () => {
  it("does not spend a KV write when nothing changes", async () => {
    const { env, kv } = setup({
      BETTER_INTRA_THEME: "dark",
      FRIENDS_LIST: ["alice"],
    });

    // Push with the same values (hub reload with auto-push, Push with no edit)
    const res = await push(env, {
      BETTER_INTRA_THEME: "dark",
      FRIENDS_LIST: ["alice"],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Saved");
    // A subset re-selecting its current value
    expect((await push(env, { BETTER_INTRA_THEME: "dark" })).status).toBe(200);
    expect((await push(env, {})).status).toBe(200);
    expect(kv.puts).toEqual([]);
  });

  it("treats a missing settings object like an empty one", async () => {
    const { env, kv } = setup(undefined);
    expect((await push(env, {})).status).toBe(200);
    expect(kv.puts).toEqual([]);
  });

  it("writes as soon as one value changes or a key is added", async () => {
    const { env, kv } = setup({ BETTER_INTRA_THEME: "dark" });
    expect((await push(env, { BETTER_INTRA_THEME: "light" })).status).toBe(200);
    expect(kv.json(LOGIN).settings).toEqual({ BETTER_INTRA_THEME: "light" });
    expect((await push(env, { LOGTIME_GOAL_HOURS: 40 })).status).toBe(200);
    expect(kv.json(LOGIN).settings).toEqual({
      BETTER_INTRA_THEME: "light",
      LOGTIME_GOAL_HOURS: 40,
    });
    expect(kv.puts).toHaveLength(2);
    // the rest of the record is kept
    expect(kv.json(LOGIN).sessionTokens).toEqual([SESSION, "session-c2"]);
  });

  it("never writes for an invalid session", async () => {
    const { env, kv } = setup({ BETTER_INTRA_THEME: "dark" });
    expect(
      (await push(env, { BETTER_INTRA_THEME: "light" }, "forged")).status,
    ).toBe(401);
    expect(kv.puts).toEqual([]);
  });

  it("rejects an array or a scalar as settings", async () => {
    const { env, kv } = setup({});
    expect((await push(env, ["a"])).status).toBe(400);
    expect((await push(env, "x")).status).toBe(400);
    expect((await push(env, null)).status).toBe(400);
    expect(kv.puts).toEqual([]);
  });
});

describe("settings POST size caps", () => {
  /** What a 413 must carry for the extension to name the culprit. */
  async function tooLarge(res: Response): Promise<TooLargeBody> {
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as TooLargeBody;
    expect(body.error).toBe("too_large");
    expect(body.message).toMatch(/too large/i);
    return body;
  }

  it("refuses a body over the cap with 413 and no KV write", async () => {
    const { env, kv } = setup({});
    const res = await push(env, {
      CUSTOM_CSS: "a".repeat(MAX_SETTING_STRING),
      HISTORY: Array.from({ length: Math.ceil(MAX_SETTINGS_BYTES / 1000) }, (_, i) => "u".repeat(1000) + i),
    });
    expect(await tooLarge(res)).toEqual({
      error: "too_large",
      key: null,
      max: MAX_SETTINGS_BYTES,
      message: "Settings too large (max 256 KB)",
    });
    expect(kv.puts).toEqual([]);
  });

  it("refuses a body announced over the cap without reading it", async () => {
    const { env, kv } = setup({});
    const req = new Request(
      `https://w.test/api/v1/private/settings?login=${LOGIN}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SESSION}`,
          "Content-Type": "application/json",
          "Content-Length": String(MAX_SETTINGS_BYTES + 1),
        },
        body: JSON.stringify({ settings: { A: 1 } }),
      },
    );
    const res = await handlePrivateSettings(req, env, LOGIN, await existing(env));
    expect((await tooLarge(res)).key).toBeNull();
    expect(kv.puts).toEqual([]);
  });

  it("refuses a single value over the string cap, naming it, but stores one at the cap", async () => {
    const { env, kv } = setup({});
    const over = await push(env, {
      A: 1,
      PROFILE_IMAGE_URL: "https://x/" + "a".repeat(MAX_SETTING_STRING),
    });
    expect(await tooLarge(over)).toEqual({
      error: "too_large",
      key: "PROFILE_IMAGE_URL",
      max: MAX_SETTING_STRING,
      message: "Setting PROFILE_IMAGE_URL too large (max 64 KB)",
    });
    expect(kv.puts).toEqual([]);

    const css = "b".repeat(MAX_SETTING_STRING);
    expect((await push(env, { CUSTOM_CSS: css })).status).toBe(200);
    expect(kv.json(LOGIN).settings.CUSTOM_CSS).toBe(css);
  });

  it("stores what real students push: a 20 KB stylesheet, and 20 presets over a 3 KB one", async () => {
    const { env, kv } = setup({});
    const css = "/* long theme */ .card { color: red } ".repeat(540); // ~20 KB
    expect(css.length).toBeGreaterThan(20_000);
    expect((await push(env, { CUSTOM_CSS: css })).status).toBe(200);

    // each preset snapshots every Customize key, the stylesheet included
    const small = "a { color: blue } ".repeat(170); // ~3 KB
    const presets = Array.from({ length: 20 }, (_, i) => ({
      name: `Preset ${i}`,
      values: { CUSTOM_CSS: small, CUSTOM_ACCENT_COLOR: "#ff00aa", filler: "x".repeat(850) },
    }));
    // over the 64 KB that used to refuse the whole push
    expect(JSON.stringify(presets).length).toBeGreaterThan(64 * 1024);
    const res = await push(env, { CUSTOM_CSS: small, CUSTOM_PRESETS: presets });
    expect(res.status).toBe(200);
    expect(kv.json(LOGIN).settings.CUSTOM_PRESETS).toHaveLength(20);
  });

  it("refuses to top an existing record up past the cap one key at a time, naming the largest key", async () => {
    const big: Record<string, string> = {};
    const fits = Math.floor(MAX_SETTINGS_BYTES / MAX_SETTING_STRING);
    for (let i = 0; i < fits; i++) big[`K${i}`] = "x".repeat(MAX_SETTING_STRING - 100 - i);
    const { env, kv } = setup(big);
    const res = await push(env, { K9: "y".repeat(MAX_SETTING_STRING - 50) });
    expect(await tooLarge(res)).toEqual({
      error: "too_large",
      key: "K9",
      max: MAX_SETTINGS_BYTES,
      message: "Settings too large (max 256 KB); largest: K9",
    });
    expect(kv.puts).toEqual([]);
    // an unchanged push of the same big record is still a free no-op
    expect((await push(env, big)).status).toBe(200);
  });
});

describe("settings GET", () => {
  it("answers the session count alone with fields=meta", async () => {
    const { env } = setup({ BETTER_INTRA_THEME: "dark", CUSTOM_CSS: "x" });
    const res = await call(env, { query: "&fields=meta" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activeSessions: 2, discordId: null });

    const full = await call(env);
    expect(await full.json()).toEqual({
      settings: { BETTER_INTRA_THEME: "dark", CUSTOM_CSS: "x" },
      activeSessions: 2,
      discordId: null,
    });
  });
});

describe("private route guard", () => {
  it("answers one and the same 401 for a missing header, an unknown login and a wrong token", async () => {
    const { env } = setup({});
    const snapshot = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort(),
    });
    const noHeader = await handlePrivateSettings(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`),
      env,
      LOGIN,
      await existing(env),
    );
    const unknown = await call(env, { login: OTHER });
    const wrong = await call(env, { session: "forged" });
    const a = await snapshot(noHeader);
    expect(a.status).toBe(401);
    expect(await snapshot(unknown)).toEqual(a);
    expect(await snapshot(wrong)).toEqual(a);
  });
});

describe("write rate limit", () => {
  it("answers 429 with Retry-After past the limit, and no-op pushes do not count", async () => {
    const { env, kv } = setup({ A: 0 });
    for (let i = 1; i <= LIMITS.write.limit; i++) {
      expect((await push(env, { A: i })).status).toBe(200);
    }
    // same payload again: nothing to write, nothing to count
    expect((await push(env, { A: LIMITS.write.limit })).status).toBe(200);
    const res = await push(env, { A: 999 });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(kv.puts).toHaveLength(LIMITS.write.limit);
    expect(kv.json(LOGIN).settings).toEqual({ A: LIMITS.write.limit });
  });

  it("is keyed by login: another user is not slowed down", async () => {
    const { env, kv } = setup({ A: 0 });
    kv.data.set(OTHER, JSON.stringify({ sessionTokens: ["s-other"], settings: {} }));
    for (let i = 1; i <= LIMITS.write.limit + 1; i++) await push(env, { A: i });
    const res = await call(env, {
      login: OTHER,
      session: "s-other",
      method: "POST",
      body: JSON.stringify({ settings: { B: 1 } }),
    });
    expect(res.status).toBe(200);
  });

  it("uses the Workers binding when it is bound", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env, kv } = setup({ A: 0 }, { WRITE_RL: rl });
    const res = await push(env, { A: 1 });
    expect(res.status).toBe(429);
    expect(rl.calls).toEqual([LOGIN]);
    expect(kv.puts).toEqual([]);
  });
});

describe("DELETE", () => {
  it("signing out is never rate limited: a 429 there left the token valid", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env, kv } = setup({ A: 1 }, { WRITE_RL: rl });
    const res = await call(env, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(kv.json(LOGIN)).toMatchObject({ sessionTokens: ["session-c2"] });
    // Wipe all data still is
    const wipe = await call(env, { method: "DELETE", query: "&all=true", session: "session-c2" });
    expect(wipe.status).toBe(429);
  });

  it("removes the calling session only", async () => {
    const { env, kv } = setup({ A: 1 });
    const res = await call(env, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(kv.json(LOGIN)).toEqual({
      sessionTokens: ["session-c2"],
      settings: { A: 1 },
    });
  });

  it("all=true wipes the record, the calendar and the users row, keeps the link tombstone", async () => {
    const { env, kv, d1 } = setup({ A: 1 });
    d1.raw.exec(
      `INSERT INTO users (hash, country) VALUES ('${LOGIN}', 'FR'), ('${OTHER}', 'DE');
       INSERT INTO calendar_tokens (token, login_hash) VALUES ('tok-c', '${LOGIN}');
       INSERT INTO calendar_ics (login_hash, ics_body) VALUES ('${LOGIN}', 'BEGIN:VCALENDAR');`,
    );
    const res = await call(env, { method: "DELETE", query: "&all=true" });
    expect(res.status).toBe(200);
    expect(kv.data.has(LOGIN)).toBe(false);
    expect(d1.rows("SELECT hash FROM users ORDER BY hash")).toEqual([
      { hash: OTHER },
    ]);
    expect(d1.rows("SELECT * FROM calendar_ics")).toEqual([]);
    const tokens = d1.rows(
      "SELECT token, revoked_at FROM calendar_tokens WHERE login_hash = ?",
      LOGIN,
    );
    expect(tokens.find((t) => t.token === "tok-c")?.revoked_at).not.toBeNull();
  });

  it("all=true keeps the record when a D1 step fails, so the wipe can be retried", async () => {
    const { env, kv, d1 } = setup({ A: 1 });
    d1.raw.exec("DROP TABLE users");
    await expect(
      call(env, { method: "DELETE", query: "&all=true" }),
    ).rejects.toThrow();
    expect(kv.data.has(LOGIN)).toBe(true);
    expect(kv.deletes).toEqual([]);
  });
});
