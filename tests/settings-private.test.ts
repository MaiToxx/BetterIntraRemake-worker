import { describe, it, expect } from "vitest";
import { handlePrivateSettings } from "../src/handlers/settings";
import type { Env, UserData } from "../src/types";
import { FakeKV, makeEnv } from "./helpers/fake-env";

const LOGIN = "c".repeat(64);
const SESSION = "session-c";

function setup(settings: Record<string, unknown> | undefined) {
  const record: UserData = { sessionTokens: [SESSION], discordId: "123" };
  if (settings) record.settings = settings;
  return makeEnv({ kv: new FakeKV({ [LOGIN]: record }) });
}

async function push(
  env: Env,
  settings: unknown,
  session = SESSION,
): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/settings?login=${LOGIN}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ settings }),
    },
  );
  const existing = (await env.BETTER_INTRA_KV.get(LOGIN, {
    type: "json",
  })) as UserData | null;
  return handlePrivateSettings(req, env, LOGIN, existing);
}

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
    expect(kv.json(LOGIN).discordId).toBe("123");
    expect(kv.json(LOGIN).sessionTokens).toEqual([SESSION]);
  });

  it("never writes for an invalid session", async () => {
    const { env, kv } = setup({ BETTER_INTRA_THEME: "dark" });
    expect(
      (await push(env, { BETTER_INTRA_THEME: "light" }, "forged")).status,
    ).toBe(401);
    expect(kv.puts).toEqual([]);
  });
});
