import { describe, it, expect, beforeEach } from "vitest";
import {
  handleCalendarIcs,
  handleCalendarToken,
  handleCalendarUpdate,
  MAX_ICS_BYTES,
} from "../src/handlers/calendar";
import { handlePrivateSettings } from "../src/handlers/settings";
import type { Env, UserData } from "../src/types";
import { FakeD1, FakeKV, makeEnv } from "./helpers/fake-env";
import { LIMITS, resetRateLimits } from "../src/rate-limit";

// The in-isolate write limiter is keyed by login and every test here writes
// as the same two logins.
beforeEach(() => {
  resetRateLimits();
});

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const SESSION: Record<string, string> = {
  [ALICE]: "session-alice",
  [BOB]: "session-bob",
};

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const LEGACY = "33333333-3333-4333-8333-333333333333";
const OLDER_LEGACY = "44444444-4444-4444-8444-444444444444";

const ICS_ALICE = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:alice exam at 10:00\r\nEND:VCALENDAR`;
const ICS_BOB = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:bob fake exam\r\nEND:VCALENDAR`;

function user(login: string, settings: Record<string, unknown> = {}): UserData {
  return { sessionTokens: [SESSION[login]], settings };
}

function setup(seed: Record<string, unknown> = {}) {
  return makeEnv({
    kv: new FakeKV({ [ALICE]: user(ALICE), [BOB]: user(BOB), ...seed }),
  });
}

async function userData(env: Env, login: string): Promise<UserData | null> {
  return (await env.BETTER_INTRA_KV.get(login, {
    type: "json",
  })) as UserData | null;
}

async function register(
  env: Env,
  login: string,
  token: unknown,
): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/calendar/token?login=${login}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SESSION[login]}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
  return handleCalendarToken(req, env, login, await userData(env, login));
}

async function upload(env: Env, login: string, ics: string): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/calendar/update?login=${login}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SESSION[login]}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ics }),
    },
  );
  return handleCalendarUpdate(req, env, login, await userData(env, login));
}

async function wipe(env: Env, login: string): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/settings?login=${login}&all=true`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SESSION[login]}` },
    },
  );
  return handlePrivateSettings(req, env, login, await userData(env, login));
}

async function feed(
  env: Env,
  token: string,
): Promise<{ status: number; body: string }> {
  const res = await handleCalendarIcs(token, env);
  return { status: res.status, body: await res.text() };
}

describe("calendar links", () => {
  it("serves the calendar of a registered link without spending KV writes", async () => {
    const { env, kv } = setup();
    expect((await register(env, ALICE, T1)).status).toBe(200);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(200);
    expect(await feed(env, T1)).toEqual({ status: 200, body: ICS_ALICE });
    expect(kv.puts).toEqual([]);
  });

  it("serves an empty calendar until the first upload", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    const { status, body } = await feed(env, T1);
    expect(status).toBe(200);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).not.toContain("VEVENT");
  });

  it("regenerating revokes the previous link", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    expect((await register(env, ALICE, T2)).status).toBe(200);
    expect((await feed(env, T1)).status).toBe(404);
    expect(await feed(env, T2)).toEqual({ status: 200, body: ICS_ALICE });
  });

  it("treats registering the live link again as a no-op", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    expect((await register(env, ALICE, T1)).status).toBe(200);
    expect((await feed(env, T1)).status).toBe(200);
  });

  it("never lets another login take over a link, live or revoked", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    await upload(env, BOB, ICS_BOB);

    expect((await register(env, BOB, T1)).status).toBe(409);
    expect(await feed(env, T1)).toEqual({ status: 200, body: ICS_ALICE });

    // a revoked link cannot be re-pointed either (calendars may still poll it)
    await register(env, ALICE, T2);
    expect((await register(env, BOB, T1)).status).toBe(409);
    expect((await register(env, ALICE, T1)).status).toBe(409);
    expect((await feed(env, T1)).status).toBe(404);
  });

  it("refuses to bind a legacy link owned by another login", async () => {
    const { env } = setup({ [`CALENDAR_TOKEN_${LEGACY}`]: ALICE });
    await upload(env, ALICE, ICS_ALICE);
    await upload(env, BOB, ICS_BOB);
    expect((await register(env, BOB, LEGACY)).status).toBe(409);
    expect(await feed(env, LEGACY)).toEqual({ status: 200, body: ICS_ALICE });
  });

  it("rejects malformed tokens and requires a session", async () => {
    const { env } = setup();
    for (const bad of [
      "short",
      "x".repeat(15),
      "has space in it 1234",
      "../../etc/passwd-1234",
      42,
      null,
    ]) {
      expect((await register(env, ALICE, bad)).status).toBe(400);
    }
    const req = new Request("https://w.test/x", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
      body: JSON.stringify({ token: T1 }),
    });
    expect(
      (await handleCalendarToken(req, env, ALICE, await userData(env, ALICE)))
        .status,
    ).toBe(401);
    expect((await feed(env, T1)).status).toBe(404);
  });

  it("answers 404 for unknown and malformed feed tokens", async () => {
    const { env } = setup();
    expect((await feed(env, T1)).status).toBe(404);
    expect((await feed(env, "short")).status).toBe(404);
    expect((await feed(env, "x".repeat(201))).status).toBe(404);
  });
});

describe("legacy KV links", () => {
  it("keep working until their login makes a new link, then all answer 404", async () => {
    const { env, kv } = setup({
      [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      [`CALENDAR_TOKEN_${OLDER_LEGACY}`]: JSON.stringify({ login: ALICE }),
      [ALICE]: user(ALICE, { CALENDAR_SYNC_TOKEN: LEGACY }),
    });
    await upload(env, ALICE, ICS_ALICE);
    expect(await feed(env, LEGACY)).toEqual({ status: 200, body: ICS_ALICE });
    expect(await feed(env, OLDER_LEGACY)).toEqual({
      status: 200,
      body: ICS_ALICE,
    });

    expect((await register(env, ALICE, T1)).status).toBe(200);
    expect((await feed(env, LEGACY)).status).toBe(404);
    expect((await feed(env, OLDER_LEGACY)).status).toBe(404);
    expect(await feed(env, T1)).toEqual({ status: 200, body: ICS_ALICE });

    // the link named in the synced settings is deleted, and cannot be reused
    expect(kv.data.has(`CALENDAR_TOKEN_${LEGACY}`)).toBe(false);
    expect((await register(env, BOB, LEGACY)).status).toBe(409);
  });

  it("can be re-registered by their owner, which retires the others", async () => {
    const { env } = setup({
      [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      [`CALENDAR_TOKEN_${OLDER_LEGACY}`]: ALICE,
    });
    await upload(env, ALICE, ICS_ALICE);
    expect((await register(env, ALICE, LEGACY)).status).toBe(200);
    expect(await feed(env, LEGACY)).toEqual({ status: 200, body: ICS_ALICE });
    expect((await feed(env, OLDER_LEGACY)).status).toBe(404);
  });

  it("are not deleted because someone else's settings name them", async () => {
    const { env, kv } = setup({
      [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      [BOB]: user(BOB, { CALENDAR_SYNC_TOKEN: LEGACY }),
    });
    await upload(env, ALICE, ICS_ALICE);
    expect((await register(env, BOB, T1)).status).toBe(200);
    expect(kv.data.get(`CALENDAR_TOKEN_${LEGACY}`)).toBe(ALICE);
    expect(await feed(env, LEGACY)).toEqual({ status: 200, body: ICS_ALICE });
  });

  it("answer 404 once their user record was wiped by the previous worker", async () => {
    const { env, kv } = setup({ [`CALENDAR_TOKEN_${LEGACY}`]: ALICE });
    await upload(env, ALICE, ICS_ALICE);
    kv.data.delete(ALICE);
    expect((await feed(env, LEGACY)).status).toBe(404);
  });
});

describe("Wipe all data", () => {
  it("revokes every link and deletes the stored calendar", async () => {
    const { env, kv, d1 } = setup({
      [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      [`CALENDAR_TOKEN_${OLDER_LEGACY}`]: ALICE,
      [ALICE]: user(ALICE, { CALENDAR_SYNC_TOKEN: LEGACY }),
    });
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    await upload(env, BOB, ICS_BOB);

    expect((await wipe(env, ALICE)).status).toBe(200);
    expect(kv.data.has(ALICE)).toBe(false);
    expect((await feed(env, T1)).status).toBe(404);
    expect((await feed(env, LEGACY)).status).toBe(404);
    expect(kv.data.has(`CALENDAR_TOKEN_${LEGACY}`)).toBe(false);
    expect(
      d1.rows("SELECT * FROM calendar_ics WHERE login_hash = ?", ALICE),
    ).toEqual([]);

    // signing in again does not bring any old link back
    kv.data.set(ALICE, JSON.stringify(user(ALICE)));
    await upload(env, ALICE, ICS_ALICE);
    for (const token of [T1, LEGACY, OLDER_LEGACY]) {
      expect((await feed(env, token)).status).toBe(404);
    }

    // other users are untouched
    expect(
      d1.rows("SELECT ics_body FROM calendar_ics WHERE login_hash = ?", BOB),
    ).toEqual([{ ics_body: ICS_BOB }]);
  });

  it("covers a login that only ever had legacy links", async () => {
    const { env, kv } = setup({ [`CALENDAR_TOKEN_${OLDER_LEGACY}`]: ALICE });
    await upload(env, ALICE, ICS_ALICE);
    await wipe(env, ALICE);
    kv.data.set(ALICE, JSON.stringify(user(ALICE)));
    expect((await feed(env, OLDER_LEGACY)).status).toBe(404);
  });
});

describe("calendar_tokens table", () => {
  it("is created on first use when schema.sql was not re-applied", async () => {
    const d1 = new FakeD1({ schema: false });
    d1.raw.exec(
      "CREATE TABLE calendar_ics (login_hash TEXT PRIMARY KEY, ics_body TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    );
    const { env } = makeEnv({
      d1,
      kv: new FakeKV({
        [ALICE]: user(ALICE),
        [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      }),
    });
    await upload(env, ALICE, ICS_ALICE);
    // a read on a fresh deploy still sees the legacy link, not an error
    expect(await feed(env, LEGACY)).toEqual({ status: 200, body: ICS_ALICE });
    expect((await register(env, ALICE, T1)).status).toBe(200);
    expect(await feed(env, T1)).toEqual({ status: 200, body: ICS_ALICE });
  });
});

describe("private calendar routes", () => {
  const snapshot = async (res: Response) => ({
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].sort(),
  });

  it("answer the same 401 for a missing header, an unknown login and a wrong token", async () => {
    const { env } = setup();
    const carol = "c".repeat(64);
    const bodies = { token: JSON.stringify({ token: T1 }), update: JSON.stringify({ ics: ICS_ALICE }) };
    for (const [path, handler, body] of [
      ["calendar/token", handleCalendarToken, bodies.token],
      ["calendar/update", handleCalendarUpdate, bodies.update],
    ] as const) {
      const req = (login: string, auth?: string) =>
        new Request(`https://w.test/api/v1/private/${path}?login=${login}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
          body,
        });
      const noHeader = await snapshot(await handler(req(ALICE), env, ALICE, await userData(env, ALICE)));
      expect(noHeader.status).toBe(401);
      expect(await snapshot(await handler(req(carol, "x"), env, carol, null))).toEqual(noHeader);
      expect(await snapshot(await handler(req(ALICE, "forged"), env, ALICE, await userData(env, ALICE)))).toEqual(noHeader);
    }
  });

  it("refuses a calendar over the cap with 413 before any D1 statement", async () => {
    const { env, d1 } = setup();
    const huge = ["BEGIN:VCALENDAR", "X:".padEnd(MAX_ICS_BYTES, "a"), "END:VCALENDAR"].join("\r\n");
    const res = await upload(env, ALICE, huge);
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/too large/i);
    expect(d1.prepared).toEqual([]);
    // a real-sized one still goes through
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(200);
  });

  it("rate-limits uploads per login, without touching D1 past the limit", async () => {
    const { env, d1 } = setup();
    for (let i = 0; i < LIMITS.write.limit; i++) {
      expect((await upload(env, ALICE, `${ICS_ALICE}${i}`)).status).toBe(200);
    }
    const statements = d1.prepared.length;
    const res = await upload(env, ALICE, ICS_ALICE);
    expect(res.status).toBe(429);
    expect(d1.prepared.length).toBe(statements);
    // bob has his own budget
    expect((await upload(env, BOB, ICS_BOB)).status).toBe(200);
  });
});
