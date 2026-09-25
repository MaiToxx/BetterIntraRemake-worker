import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleCalendarIcs,
  handleCalendarToken,
  handleCalendarUpdate,
  MAX_ICS_BYTES,
} from "../src/handlers/calendar";
import { handlePrivateSettings } from "../src/handlers/settings";
import type { Env, UserData } from "../src/types";
import { FakeD1, FakeKV, FakeRateLimit, MIGRATIONS, addSession, makeEnv } from "./helpers/fake-env";
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

const ICS_ALICE = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:alice exam at 10:00\r\nEND:VCALENDAR`;
const ICS_BOB = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:bob fake exam\r\nEND:VCALENDAR`;

function user(login: string, settings: Record<string, unknown> = {}): UserData {
  return { sessionTokens: [SESSION[login]], settings };
}

function setup(seed: Record<string, unknown> = {}, vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({ [ALICE]: user(ALICE), [BOB]: user(BOB), ...seed }),
    vars,
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

/** GET /api/v1/private/calendar/token: the live link, as another browser asks. */
async function liveLink(env: Env, login: string, auth = SESSION[login]): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/calendar/token?login=${login}`,
    { headers: { Authorization: `Bearer ${auth}` } },
  );
  return handleCalendarToken(req, env, login, await userData(env, login));
}

async function liveToken(env: Env, login: string): Promise<unknown> {
  const res = await liveLink(env, login);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: unknown }).token;
}

/** "Stop sharing": DELETE /api/v1/private/calendar/token. */
async function stop(env: Env, login: string, auth = SESSION[login]): Promise<Response> {
  const req = new Request(
    `https://w.test/api/v1/private/calendar/token?login=${login}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${auth}` } },
  );
  return handleCalendarToken(req, env, login, await userData(env, login));
}

async function feed(
  env: Env,
  token: string,
): Promise<{ status: number; body: string }> {
  const res = await handleCalendarIcs(token, env);
  return { status: res.status, body: await res.text() };
}

/** Statements of the calendar itself, leaving out the session checks. */
const calendarStatements = (d1: FakeD1) =>
  d1.prepared.filter((sql) => /calendar_/.test(sql));

/**
 * Signing in again after a wipe: a new session in D1, and the record a
 * first sign-in creates.
 */
function signInAgain(d1: FakeD1, kv: FakeKV, login: string): void {
  kv.data.set(login, JSON.stringify({ settings: {} }));
  addSession(d1, login, SESSION[login]);
}

describe("calendar links", () => {
  it("serves both feed forms privately cached and never sniffed", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    const headers = (res: Response) => ({
      cache: res.headers.get("Cache-Control"),
      nosniff: res.headers.get("X-Content-Type-Options"),
      type: res.headers.get("Content-Type"),
    });
    const expected = {
      cache: "private, max-age=3600",
      nosniff: "nosniff",
      type: "text/calendar; charset=utf-8",
    };
    // no upload yet: the empty calendar
    expect(headers(await handleCalendarIcs(T1, env))).toEqual(expected);
    await upload(env, ALICE, ICS_ALICE);
    expect(headers(await handleCalendarIcs(T1, env))).toEqual(expected);
  });

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

describe("legacy KV links (CALENDAR_TOKEN_*)", () => {
  // The live namespace holds none any more: such a key opens nothing, and
  // the calendar routes read no KV at all.
  it("open nothing and are never read", async () => {
    const { env, kv } = setup({
      [`CALENDAR_TOKEN_${LEGACY}`]: ALICE,
      [ALICE]: user(ALICE, { CALENDAR_SYNC_TOKEN: LEGACY }),
    });
    await upload(env, ALICE, ICS_ALICE);
    expect(await liveToken(env, BOB)).toBeNull(); // bob's sessions now in D1
    const getSpy = vi.spyOn(kv, "get");
    expect((await feed(env, LEGACY)).status).toBe(404);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();

    // a token nobody registered in D1 is free to register; neither that nor
    // a stop reads the record (it used to, for the legacy link it named)
    const record = vi.fn(async () => user(BOB));
    const call = (method: string, login: string, body?: string) =>
      handleCalendarToken(
        new Request(`https://w.test/api/v1/private/calendar/token?login=${login}`, {
          method,
          headers: { Authorization: `Bearer ${SESSION[login]}`, "Content-Type": "application/json" },
          body,
        }),
        env,
        login,
        record,
      );
    expect((await call("POST", BOB, JSON.stringify({ token: LEGACY }))).status).toBe(200);
    expect((await call("DELETE", ALICE)).status).toBe(204);
    expect(record).not.toHaveBeenCalled();
    expect(kv.deletes).toEqual([]);
    expect(kv.data.has(`CALENDAR_TOKEN_${LEGACY}`)).toBe(true);
  });
});

describe("Wipe all data", () => {
  it("revokes every link and deletes the stored calendar", async () => {
    const { env, kv, d1 } = setup();
    await register(env, ALICE, T1);
    await register(env, ALICE, T2);
    await upload(env, ALICE, ICS_ALICE);
    await upload(env, BOB, ICS_BOB);

    expect((await wipe(env, ALICE)).status).toBe(200);
    expect(kv.data.has(ALICE)).toBe(false);
    expect((await feed(env, T2)).status).toBe(404);
    expect(
      d1.rows("SELECT * FROM calendar_ics WHERE login_hash = ?", ALICE),
    ).toEqual([]);

    // signing in again does not bring any old link back
    signInAgain(d1, kv, ALICE);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(410);
    expect(await liveToken(env, ALICE)).toBeNull();
    for (const token of [T1, T2]) {
      expect((await feed(env, token)).status).toBe(404);
    }

    // other users are untouched
    expect(
      d1.rows("SELECT ics_body FROM calendar_ics WHERE login_hash = ?", BOB),
    ).toEqual([{ ics_body: ICS_BOB }]);
  });

  it("leaves no row naming a login that never made a link", async () => {
    const { env, d1 } = setup();
    d1.raw.prepare("INSERT INTO users (hash) VALUES (?)").run(ALICE);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(200);
    expect((await wipe(env, ALICE)).status).toBe(200);
    // The wipe takes the student out of D1: no users row, no stored calendar,
    // and no `wiped:` marker row keyed by the login hash in its place.
    expect(d1.rows("SELECT hash FROM users WHERE hash = ?", ALICE)).toEqual([]);
    expect(d1.rows("SELECT * FROM calendar_ics WHERE login_hash = ?", ALICE)).toEqual([]);
    expect(d1.rows("SELECT * FROM calendar_tokens WHERE login_hash = ?", ALICE)).toEqual([]);
    expect(d1.rows("SELECT * FROM calendar_tokens")).toEqual([]);
  });

  it("keeps a marker an earlier worker wrote revoked: uploads still stop", async () => {
    const { env, kv, d1 } = setup();
    d1.raw
      .prepare("INSERT INTO calendar_tokens (token, login_hash, revoked_at) VALUES (?, ?, unixepoch())")
      .run("wiped:61cb0000-0000-4000-8000-000000000000", ALICE);
    await wipe(env, ALICE);
    signInAgain(d1, kv, ALICE);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(410);
    expect(await liveToken(env, ALICE)).toBeNull();
    expect(d1.rows("SELECT COUNT(*) AS n FROM calendar_tokens WHERE login_hash = ?", ALICE)).toEqual([{ n: 1 }]);
  });
});

describe("calendar_tokens table", () => {
  it("is created on first use when the baseline migration was not applied", async () => {
    const d1 = new FakeD1({ schema: false });
    d1.raw.exec(
      "CREATE TABLE calendar_ics (login_hash TEXT PRIMARY KEY, ics_body TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    );
    // the later migrations (sessions) are applied before a deploy needs them
    for (const m of MIGRATIONS) if (!m.name.startsWith("0001_")) d1.raw.exec(m.sql);
    const { env } = makeEnv({ d1, kv: new FakeKV({ [ALICE]: user(ALICE) }) });
    // a read on a fresh deploy answers, not an error
    expect(await liveToken(env, ALICE)).toBeNull();
    await upload(env, ALICE, ICS_ALICE);
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

  it("refuses a calendar over the cap with 413 before any calendar statement", async () => {
    const { env, d1 } = setup();
    const huge = ["BEGIN:VCALENDAR", "X:".padEnd(MAX_ICS_BYTES, "a"), "END:VCALENDAR"].join("\r\n");
    const res = await upload(env, ALICE, huge);
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/too large/i);
    expect(calendarStatements(d1)).toEqual([]);
    // a real-sized one still goes through
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(200);
  });

  it("rate-limits uploads per login, without a calendar statement past the limit", async () => {
    const { env, d1 } = setup();
    for (let i = 0; i < LIMITS.write.limit; i++) {
      expect((await upload(env, ALICE, `${ICS_ALICE}${i}`)).status).toBe(200);
    }
    const statements = calendarStatements(d1).length;
    const res = await upload(env, ALICE, ICS_ALICE);
    expect(res.status).toBe(429);
    expect(calendarStatements(d1).length).toBe(statements);
    // bob has his own budget
    expect((await upload(env, BOB, ICS_BOB)).status).toBe(200);
  });
});

describe("Stop sharing (DELETE calendar/token)", () => {
  const icsRows = (d1: FakeD1, login: string) =>
    d1.rows("SELECT ics_body FROM calendar_ics WHERE login_hash = ?", login);

  it("revokes the link and deletes the stored calendar, and nothing else", async () => {
    const { env, kv, d1 } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    await register(env, BOB, T2);
    await upload(env, BOB, ICS_BOB);

    const res = await stop(env, ALICE);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await feed(env, T1)).status).toBe(404);
    expect(icsRows(d1, ALICE)).toEqual([]);
    // not "Wipe all data": the settings backup and the session stay
    expect(await userData(env, ALICE)).toEqual(user(ALICE));
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    // other users are untouched
    expect(await feed(env, T2)).toEqual({ status: 200, body: ICS_BOB });
  });

  it("refuses later uploads with 410 until a new link is made", async () => {
    const { env, d1 } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    await stop(env, ALICE);

    // a second browser that restored CALENDAR_SYNC_TOKEN from the cloud
    const res = await upload(env, ALICE, ICS_ALICE);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: "calendar_stopped",
      message: expect.stringMatching(/stopped/),
    });
    expect(icsRows(d1, ALICE)).toEqual([]);

    // "Generate calendar link" again: sharing resumes on the new link only
    expect((await register(env, ALICE, T2)).status).toBe(200);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(200);
    expect(await feed(env, T2)).toEqual({ status: 200, body: ICS_ALICE });
    expect((await feed(env, T1)).status).toBe(404);
  });

  it("is not undone by an upload already past its checks when the stop lands", async () => {
    const { env, d1 } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    // The stop commits right before the upload's write: a check made earlier
    // in that request would still have seen the live link.
    const prepare = d1.prepare.bind(d1);
    let stopped = false;
    d1.prepare = (sql: string) => {
      if (!stopped && /INTO calendar_ics/.test(sql)) {
        stopped = true;
        d1.raw
          .prepare("UPDATE calendar_tokens SET revoked_at = unixepoch() WHERE login_hash = ?")
          .run(ALICE);
        d1.raw.prepare("DELETE FROM calendar_ics WHERE login_hash = ?").run(ALICE);
      }
      return prepare(sql);
    };
    const res = await upload(env, ALICE, ICS_ALICE);
    expect(stopped).toBe(true);
    expect(res.status).toBe(410);
    expect(icsRows(d1, ALICE)).toEqual([]);
  });

  it("also refuses uploads after a wipe, and never a login without a D1 link", async () => {
    const { env, kv, d1 } = setup();
    await register(env, ALICE, T1);
    await wipe(env, ALICE);
    signInAgain(d1, kv, ALICE);
    expect((await upload(env, ALICE, ICS_ALICE)).status).toBe(410);
    expect(icsRows(d1, ALICE)).toEqual([]);

    // bob never made a link (no row): his uploads are stored, for the link
    // he may make next
    expect((await upload(env, BOB, ICS_BOB)).status).toBe(200);
    expect(icsRows(d1, BOB)).toEqual([{ ics_body: ICS_BOB }]);
  });

  it("answers the same 401 as every private route, and changes nothing", async () => {
    const { env, d1 } = setup();
    await register(env, ALICE, T1);
    await upload(env, ALICE, ICS_ALICE);
    const snapshot = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort(),
    });
    const noHeader = await snapshot(
      await handleCalendarToken(
        new Request(`https://w.test/api/v1/private/calendar/token?login=${ALICE}`, {
          method: "DELETE",
        }),
        env,
        ALICE,
        await userData(env, ALICE),
      ),
    );
    expect(noHeader.status).toBe(401);
    expect(await snapshot(await stop(env, ALICE, "forged"))).toEqual(noHeader);
    const carol = "c".repeat(64);
    expect(
      await snapshot(
        await handleCalendarToken(
          new Request(`https://w.test/api/v1/private/calendar/token?login=${carol}`, {
            method: "DELETE",
            headers: { Authorization: "Bearer x" },
          }),
          env,
          carol,
          null,
        ),
      ),
    ).toEqual(noHeader);
    expect(await feed(env, T1)).toEqual({ status: 200, body: ICS_ALICE });
    expect(icsRows(d1, ALICE)).toEqual([{ ics_body: ICS_ALICE }]);
  });

  it("is limited in the write bucket, before any calendar statement", async () => {
    const { env, d1 } = setup();
    for (let i = 0; i < LIMITS.write.limit; i++) {
      expect((await stop(env, ALICE)).status).toBe(204);
    }
    // no row for a login that had none, whatever the number of clicks
    expect(
      d1.rows("SELECT COUNT(*) AS n FROM calendar_tokens WHERE login_hash = ?", ALICE),
    ).toEqual([{ n: 0 }]);
    const statements = calendarStatements(d1).length;
    const res = await stop(env, ALICE);
    expect(res.status).toBe(429);
    expect(calendarStatements(d1).length).toBe(statements);
  });

  it("refuses the other methods", async () => {
    const { env } = setup();
    for (const method of ["PUT", "PATCH"]) {
      const req = new Request(
        `https://w.test/api/v1/private/calendar/token?login=${ALICE}`,
        { method, headers: { Authorization: `Bearer ${SESSION[ALICE]}` } },
      );
      expect(
        (await handleCalendarToken(req, env, ALICE, await userData(env, ALICE))).status,
      ).toBe(405);
    }
  });
});

describe("GET calendar/token: the live link, for the other browsers", () => {
  it("answers the live token, the new one after a regenerate, null after a stop", async () => {
    const { env } = setup();
    expect(await liveToken(env, ALICE)).toBeNull();
    await register(env, ALICE, T1);
    expect(await liveToken(env, ALICE)).toBe(T1);
    await register(env, ALICE, T2);
    expect(await liveToken(env, ALICE)).toBe(T2);
    // bob's link is his own
    expect(await liveToken(env, BOB)).toBeNull();
    await stop(env, ALICE);
    expect(await liveToken(env, ALICE)).toBeNull();
    // a new link after the stop is live again (a revoked one never comes back)
    const t3 = "55555555-5555-4555-8555-555555555555";
    expect((await register(env, ALICE, T1)).status).toBe(409);
    await register(env, ALICE, t3);
    expect(await liveToken(env, ALICE)).toBe(t3);
  });

  it("never answers a wipe marker or a revoked token", async () => {
    const { env, d1 } = setup();
    await stop(env, ALICE); // a login without a link: nothing to revoke, no row
    expect(d1.rows("SELECT token FROM calendar_tokens WHERE login_hash = ?", ALICE)).toEqual([]);
    expect(await liveToken(env, ALICE)).toBeNull();
    // a marker an earlier worker wrote, and a revoked link
    d1.raw
      .prepare("INSERT INTO calendar_tokens (token, login_hash, revoked_at) VALUES (?, ?, unixepoch())")
      .run("wiped:7baf0000-0000-4000-8000-000000000000", ALICE);
    await register(env, BOB, T1);
    await stop(env, BOB);
    expect(await liveToken(env, ALICE)).toBeNull();
    expect(await liveToken(env, BOB)).toBeNull();
  });

  it("is uncached JSON, writes nothing, and is not rate limited", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env, kv, d1 } = setup({}, { WRITE_RL: rl });
    d1.raw.exec(`INSERT INTO calendar_tokens (token, login_hash) VALUES ('${T1}', '${ALICE}')`);
    const res = await liveLink(env, ALICE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.json()).toEqual({ token: T1 });
    expect(rl.calls).toEqual([]);
    expect(kv.puts).toEqual([]);
    expect(d1.prepared.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && /calendar/.test(sql))).toBe(false);
  });

  it("answers the one 401 of the private routes", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    const snapshot = async (res: Response) => ({
      status: res.status,
      body: await res.text(),
      headers: [...res.headers.entries()].sort(),
    });
    const forged = await snapshot(await liveLink(env, ALICE, "forged"));
    expect(forged.status).toBe(401);
    expect(forged.body).not.toContain(T1);
    const upload401 = await snapshot(
      await handleCalendarUpdate(
        new Request(`https://w.test/api/v1/private/calendar/update?login=${ALICE}`, {
          method: "POST",
          headers: { Authorization: "Bearer forged" },
          body: JSON.stringify({ ics: ICS_ALICE }),
        }),
        env,
        ALICE,
        await userData(env, ALICE),
      ),
    );
    expect(forged).toEqual(upload401);
  });
});

describe("calendar error bodies", () => {
  it("carry a stable code and an English message", async () => {
    const { env } = setup();
    await register(env, ALICE, T1);
    const body = async (res: Response) => ({ status: res.status, ...((await res.json()) as object) });
    expect(await body(await register(env, BOB, T1))).toEqual({
      status: 409,
      error: "conflict",
      message: "Token already in use",
    });
    expect(await body(await register(env, ALICE, "short"))).toEqual({
      status: 400,
      error: "bad_request",
      message: "Invalid token",
    });
    expect(await body(await upload(env, ALICE, "x"))).toEqual({
      status: 400,
      error: "bad_request",
      message: "Invalid ics body",
    });
    const feed404 = await handleCalendarIcs(T2, env);
    expect(await body(feed404)).toEqual({ status: 404, error: "not_found", message: "Not found" });
  });
});
