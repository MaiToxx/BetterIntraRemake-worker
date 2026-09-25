/**
 * Extension 1.17.1 (and older builds) against this worker.
 *
 * Those builds stay installed for weeks after a worker deploy, and they know
 * nothing of D1 sessions, settings revisions, error codes or the new routes.
 * Each case below replays the requests 1.17.1 sends, built the way its
 * workerFetch() builds them (src/core/worker.ts of the extension at v1.17.1:
 * `login` query, Bearer header, JSON body; plain fetch() for the public
 * routes), and reads the answers the way its callers read them: the status,
 * `json` when the body parses, else `text`, and `message` of a JSON error
 * body. What is asserted is what those callers depend on, nothing more, so a
 * change that breaks an installed build fails here even if the worker's own
 * tests were updated with it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { INTRA_ISSUER, resetJwksRefreshThrottle, type Jwk } from "../src/handlers/intra-auth";
import { resetAnnouncementCache } from "../src/handlers/announcement";
import { resetStatsCache } from "../src/handlers/stats";
import { resetRateLimits } from "../src/rate-limit";
import { hashLogin, KV_RETRY } from "../src/utils";
import type { Env } from "../src/types";
import { FakeKV, makeEnv } from "./helpers/fake-env";
import { readFixture } from "./helpers/fixtures";

const WORKER = "https://betterintra-remake.maitox.workers.dev";
/** The popup and the hub run on the extension's origin... */
const POPUP_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
/** ...content scripts send the Intra page's. */
const PAGE_ORIGIN = "https://profile-v3.intra.42.fr";
const LOGIN = "alepayen";

// ---------------------------------------------------------------------------
// The client, as 1.17.1 has it
// ---------------------------------------------------------------------------

interface Result1171 {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
  error?: string;
  message?: string;
  headers: Headers;
}

interface Options1171 {
  method?: string;
  body?: unknown;
  auth?: { login: string; token: string };
  headers?: Record<string, string>;
  origin?: string;
}

/** workerFetch() of 1.17.1, minus the timer: same URL, headers, body and parsing. */
async function workerFetch(env: Env, path: string, options: Options1171 = {}): Promise<Result1171> {
  const url = new URL(WORKER + path);
  const headers: Record<string, string> = {
    Origin: options.origin ?? POPUP_ORIGIN,
    ...(options.headers ?? {}),
  };
  if (options.auth) {
    url.searchParams.set("login", await hashLogin(options.auth.login));
    headers.Authorization = `Bearer ${options.auth.token}`;
  }
  let body: BodyInit | undefined;
  if (typeof options.body === "string" || options.body instanceof Uint8Array) {
    body = options.body as BodyInit;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }
  const response = await worker.fetch(
    new Request(url, { method: options.method ?? "GET", headers, body }),
    env,
  );
  const text = await response.text();
  const result: Result1171 = {
    ok: response.ok,
    status: response.status,
    json: null,
    text,
    headers: response.headers,
  };
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      result.json = JSON.parse(text);
      result.text = "";
    } catch {
      // not JSON after all: left in `text`
    }
  }
  if (result.json && typeof result.json === "object") {
    const { error, message } = result.json as Record<string, unknown>;
    if (typeof error === "string") result.error = error;
    if (typeof message === "string") result.message = message;
  }
  return result;
}

/** A plain fetch() from a content script (visuals, announcement, stats, /gh/). */
const pageFetch = (env: Env, path: string) =>
  worker.fetch(new Request(WORKER + path, { headers: { Origin: PAGE_ORIGIN } }), env);

/**
 * What 1.17.1 shows for a failed call: `res.message ?? res.text` (account.ts,
 * intra-login.ts). An error body it could not read would show nothing.
 */
const shown = (res: Result1171) => res.message ?? res.text;

/** Every answer a content script reads must carry CORS. */
function expectCors(res: { headers: Headers }) {
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
}

// ---------------------------------------------------------------------------
// Keycloak stand-in
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let privateKey: CryptoKey;
let jwks: Jwk[];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwks = [{ kid: "k1", kty: "RSA", alg: "RS256", use: "sig", n: pub.n!, e: pub.e! }];
});

/** The Intra v3 page's token, as hook.js captures it. */
async function intraToken(login = LOGIN): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const payload = b64url(
    JSON.stringify({
      iss: INTRA_ISSUER,
      sub: "sub-1",
      azp: "frontend-react",
      preferred_username: login,
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, Buffer.from(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const PDF_URL = "https://cdn.intra.42.fr/pdf/pdf/900001/en.subject.pdf";
const SVG_URL = "https://cdn.intra.42.fr/cluster/image/1/e1.svg";

/** Every host the worker reaches for these flows. */
function upstream(input: RequestInfo | URL): Response {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${INTRA_ISSUER}/protocol/openid-connect/certs`)) {
    return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
  }
  if (url === PDF_URL) {
    return new Response("%PDF-1.7 << /CreationDate (D:20260811161924+02'00') /ModDate (D:20260811161924+02'00') >>");
  }
  if (url === SVG_URL) {
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }
  if (url.startsWith("https://raw.githubusercontent.com/") && url.endsWith("/campuses/index.json")) {
    return new Response('{"campuses":[]}', { headers: { "Content-Type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
}

/** A record the previous worker (ce12afc) wrote: tokens in clear, no revision. */
function previousWorkerRecord(tokens: string[], settings: Record<string, unknown> = {}) {
  return { sessionTokens: tokens, settings };
}

beforeEach(() => {
  resetRateLimits();
  resetJwksRefreshThrottle();
  resetAnnouncementCache();
  resetStatsCache();
  KV_RETRY.delayMs = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => upstream(input)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  KV_RETRY.delayMs = 1100;
});

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

describe("1.17.1 signed in under the previous worker", () => {
  async function legacy() {
    const hash = await hashLogin(LOGIN);
    const settings = { THEME: "dark", FRIENDS_LIST: ["bob"], PROFILE_IMAGE_URL: "https://img.test/a.png" };
    const made = makeEnv({
      kv: new FakeKV({ [hash]: previousWorkerRecord(["old-a", "old-b"], settings) }),
    });
    return { ...made, hash, settings };
  }

  it("keeps its session: the popup's meta read, the restore read, the push and the sign-out", async () => {
    const { env, kv, hash, settings } = await legacy();
    const auth = { login: LOGIN, token: "old-b" };

    // popup: fetchPrivateSettings({meta: true}) -> activeSessions
    const meta = await workerFetch(env, "/api/v1/private/settings?fields=meta", { auth });
    expect(meta.status).toBe(200);
    expectCors(meta);
    expect(Number((meta.json as { activeSessions: unknown }).activeSessions)).toBe(2);

    // restore: fetchMySettings() -> settings
    const full = await workerFetch(env, "/api/v1/private/settings", { auth });
    expect(full.ok).toBe(true);
    expect((full.json as { settings: unknown }).settings).toEqual(settings);

    // pushSettings(): the whole CLOUD_SYNC_KEYS set, no baseRev
    const push = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      body: { settings: { ...settings, THEME: "light" } },
      auth,
    });
    expect(push.ok).toBe(true);
    expect(push.text).toBe("Saved");
    expect(push.json).toBeNull();
    expectCors(push);
    // the record lost its tokens in clear, and the other browser stays in
    expect(kv.json(hash).sessionTokens).toBeUndefined();
    expect(kv.json(hash).settings.THEME).toBe("light");
    const other = await workerFetch(env, "/api/v1/private/settings", { auth: { login: LOGIN, token: "old-a" } });
    expect(other.status).toBe(200);
    expect((other.json as { settings: { THEME: string } }).settings.THEME).toBe("light");

    // logoutCloud(): DELETE, then the token is gone
    const out = await workerFetch(env, "/api/v1/private/settings", { method: "DELETE", auth });
    expect(out.ok).toBe(true);
    expect(out.text).toBe("Session removed");
    const after = await workerFetch(env, "/api/v1/private/settings?fields=meta", { auth });
    // 401 is what flags CLOUD_AUTH_FAILED ("Reconnect") in every build
    expect(after.status).toBe(401);
    expect(shown(after)).toBe("Unauthorized");
    expectCors(after);
    // and the other browser's session is untouched
    expect((await workerFetch(env, "/api/v1/private/settings?fields=meta", { auth: { login: LOGIN, token: "old-a" } })).status).toBe(200);
  });

  it("sends partial pushes (quick visuals sync, forgetCloudCalendarLink) that merge and answer the text", async () => {
    const { env, kv, hash } = await legacy();
    const auth = { login: LOGIN, token: "old-a" };
    const visuals = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      auth,
      body: {
        settings: {
          PROFILE_IMAGE_URL: "https://img.test/b.png",
          PROFILE_BANNER_URL: "",
          PROFILE_BANNER_MODE: "fill",
          PROFILE_AVATAR_POSITION_X: 50,
          PROFILE_AVATAR_POSITION_Y: 50,
          PROFILE_AVATAR_SCALE: 100,
          PROFILE_IMAGE_HISTORY: ["https://img.test/a.png"],
        },
      },
    });
    expect(visuals.ok).toBe(true);
    expect(visuals.text).toBe("Saved");
    const calendar = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      auth,
      body: { settings: { CALENDAR_SYNC_TOKEN: "", CALENDAR_EVENTS_HASH: "" } },
    });
    expect(calendar.text).toBe("Saved");
    const stored = kv.json(hash).settings;
    expect(stored.FRIENDS_LIST).toEqual(["bob"]);
    expect(stored.PROFILE_IMAGE_URL).toBe("https://img.test/b.png");
    expect(stored.CALENDAR_SYNC_TOKEN).toBe("");
    // what visitors see follows the push, in the shape 1.17.1 reads
    const pub = await pageFetch(env, `/api/v1/public/visuals?login=${hash}`);
    expect(pub.status).toBe(200);
    expectCors(pub);
    expect(((await pub.json()) as { avatar: string }).avatar).toBe("https://img.test/b.png");
  });

  it("reads a too-large push as 'too-large' and shows the worker's words", async () => {
    const { env } = await legacy();
    const res = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      auth: { login: LOGIN, token: "old-a" },
      body: { settings: { CUSTOM_CSS: "a".repeat(64 * 1024 + 1) } },
    });
    expect(res.status).toBe(413);
    expect(shown(res)).toBe("Setting CUSTOM_CSS too large (max 64 KB)");
  });

  it("wipes all cloud data with the text answer, and the session goes with it", async () => {
    const { env, kv, hash } = await legacy();
    const auth = { login: LOGIN, token: "old-a" };
    const wipe = await workerFetch(env, "/api/v1/private/settings?all=true", { method: "DELETE", auth });
    expect(wipe.ok).toBe(true);
    expect(wipe.text).toBe("All cloud data deleted");
    expect(kv.data.has(hash)).toBe(false);
    for (const token of ["old-a", "old-b"]) {
      expect((await workerFetch(env, "/api/v1/private/settings", { auth: { login: LOGIN, token } })).status).toBe(401);
    }
  });
});

describe("1.17.1 signing in and using every route", () => {
  it("signs in from the Intra page and gets {token, login}", async () => {
    const { env, kv } = makeEnv();
    for (const token of [await intraToken(), `Bearer ${await intraToken()}`]) {
      const res = await workerFetch(env, "/auth/intra", {
        method: "POST",
        body: { token },
        origin: PAGE_ORIGIN,
      });
      expect(res.status).toBe(200);
      expectCors(res);
      const data = res.json as { token?: unknown; login?: unknown };
      expect(typeof data.token).toBe("string");
      expect(data.login).toBe(LOGIN);
    }
    // no token in clear anywhere in KV
    for (const value of kv.data.values()) {
      if (typeof value === "string") expect(value).not.toMatch(/sessionTokens/);
    }
  });

  it("gets the statuses and texts its sign-in branches on: 401, 429", async () => {
    const { env } = makeEnv();
    const bad = await workerFetch(env, "/auth/intra", {
      method: "POST",
      body: { token: (await intraToken()).slice(0, -8) + "AAAAAAAA" },
      origin: PAGE_ORIGIN,
    });
    expect(bad.status).toBe(401);
    expect(shown(bad)).toBe("Invalid or expired Intra token");
    let last: Result1171 | null = null;
    for (let i = 0; i < 11; i++) {
      last = await workerFetch(env, "/auth/intra", { method: "POST", body: { token: await intraToken() }, origin: PAGE_ORIGIN });
    }
    expect(last!.status).toBe(429);
  });

  it("uses the calendar, images, subject tracker and public routes as before", async () => {
    const { env } = makeEnv();
    const signIn = await workerFetch(env, "/auth/intra", { method: "POST", body: { token: await intraToken() }, origin: PAGE_ORIGIN });
    const auth = { login: LOGIN, token: (signIn.json as { token: string }).token };
    const hash = await hashLogin(LOGIN);

    // A first push creates the settings (the popup's meta read works before it)
    expect((await workerFetch(env, "/api/v1/private/settings?fields=meta", { auth })).status).toBe(200);
    const first = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      auth,
      body: { settings: { PROFILE_IMAGE_URL: "https://img.test/me.png", CUSTOM_SHARE_LOOK: true, CUSTOM_RADIUS: 10 } },
    });
    expect(first.text).toBe("Saved");

    // Calendar: generate, upload (calendar-sync.ts), subscribe, stop
    const link = crypto.randomUUID();
    const gen = await workerFetch(env, "/api/v1/private/calendar/token", { method: "POST", body: { token: link }, auth });
    expect(gen.ok).toBe(true);
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BetterIntra//Events//EN", "END:VCALENDAR"].join("\r\n");
    const up = await workerFetch(env, "/api/v1/private/calendar/update", { method: "POST", body: { ics }, auth, origin: PAGE_ORIGIN });
    expect(up.ok).toBe(true);
    expectCors(up);
    const feed = await worker.fetch(new Request(`${WORKER}/calendar/${link}.ics`), env);
    expect(feed.status).toBe(200);
    expect(feed.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(await feed.text()).toBe(ics);
    const stop = await workerFetch(env, "/api/v1/private/calendar/token", { method: "DELETE", auth });
    expect(stop.status).toBe(204);
    const again = await workerFetch(env, "/api/v1/private/calendar/update", { method: "POST", body: { ics }, auth, origin: PAGE_ORIGIN });
    // 410 is what makes calendar-sync.ts forget the dead link
    expect(again.status).toBe(410);

    // Images: upload (raw body, image type), serve, delete
    const png = readFixture("gps.png");
    const upload = await workerFetch(env, "/api/v1/private/images?slot=avatar", {
      method: "POST",
      body: png,
      headers: { "Content-Type": "image/png" },
      auth,
      origin: PAGE_ORIGIN,
    });
    expect(upload.ok).toBe(true);
    const url = (upload.json as { url?: unknown }).url;
    expect(typeof url).toBe("string");
    const served = await worker.fetch(new Request(url as string), env);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    const del = await workerFetch(env, "/api/v1/private/images?slot=avatar", { method: "DELETE", auth, origin: PAGE_ORIGIN });
    expect(del.ok).toBe(true);
    // its 413 and 415 branches read the status only
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(png);
    expect((await workerFetch(env, "/api/v1/private/images?slot=banner", { method: "POST", body: big, auth })).status).toBe(413);
    expect((await workerFetch(env, "/api/v1/private/images?slot=banner", { method: "POST", body: "not an image", auth })).status).toBe(415);

    // Subject tracker: state, then a first report. A new minute for the write
    // limiter: a student does not do all of the above within one.
    resetRateLimits();
    const state = await workerFetch(env, "/api/v1/private/subjects/state?slugs=libft", { auth, origin: PAGE_ORIGIN });
    expect(state.ok).toBe(true);
    expect((state.json as { subjects: { slug: string; tracked: boolean }[] }).subjects).toEqual([
      expect.objectContaining({ slug: "libft", tracked: false }),
    ]);
    const report = await workerFetch(env, "/api/v1/private/subjects/report", {
      method: "POST",
      body: { items: [{ slug: "libft", url: PDF_URL }] },
      auth,
      origin: PAGE_ORIGIN,
    });
    expect(report.ok).toBe(true);
    const entry = (report.json as { subjects: { slug: string; status: string; createdAt: number | null }[] }).subjects[0];
    expect(entry).toEqual(expect.objectContaining({ slug: "libft", status: "first" }));
    expect(typeof entry.createdAt).toBe("number");

    // Public visuals: single and batch (friends), in the shape 1.17.1 reads
    const single = await pageFetch(env, `/api/v1/public/visuals?login=${hash}`);
    expect(single.status).toBe(200);
    const one = (await single.json()) as Record<string, unknown>;
    expect(one.avatar).toBe("https://img.test/me.png");
    expect(one.look).toEqual({ CUSTOM_RADIUS: 10 });
    for (const key of ["banner", "bannerMode", "background", "avatarBg", "decoration", "avatarPosX", "theme", "logtime", "extras"]) {
      expect(one).toHaveProperty(key);
    }
    const unknown = "f".repeat(64);
    const batch = await pageFetch(env, `/api/v1/public/visuals?logins=${encodeURIComponent([hash, unknown].join(","))}`);
    expect(batch.status).toBe(200);
    const { visuals } = (await batch.json()) as { visuals: Record<string, Record<string, unknown>> };
    expect(visuals[hash]).toEqual(one);
    expect(visuals[unknown].avatar).toBe("");
  });

  it("reads the announcement, the stats, the campus files and a cluster map", async () => {
    const { env } = makeEnv();
    const ann = await pageFetch(env, "/api/v1/public/announcement");
    expect(ann.status).toBe(200);
    expectCors(ann);
    expect(await ann.json()).toEqual({ message: null, updatedAt: null, level: "critical", links: [] });

    const stats = await pageFetch(env, "/api/v1/public/stats");
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual(expect.objectContaining({ total: 0, countries: [] }));

    const campus = await pageFetch(env, "/gh/campuses/index.json");
    expect(campus.status).toBe(200);
    expect(await campus.json()).toEqual({ campuses: [] });
    // campus.ts caches "no data file" on a 404 only
    expect((await pageFetch(env, "/gh/campuses/99.json")).status).toBe(404);

    const map = await pageFetch(env, `/api/v1/cluster/svg?url=${encodeURIComponent(SVG_URL)}`);
    expect(map.ok).toBe(true);
    expect(await map.text()).toContain("<svg");
  });

  it("answers the preflight of every authenticated call", async () => {
    const { env } = makeEnv();
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await worker.fetch(
        new Request(`${WORKER}/api/v1/private/settings?login=${"a".repeat(64)}`, {
          method: "OPTIONS",
          headers: {
            Origin: PAGE_ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization,content-type",
          },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain(method);
      expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Authorization/);
      expect(res.headers.get("Access-Control-Allow-Headers")).toMatch(/Content-Type/);
    }
  });
});

describe("1.17.1 next to a newer build of the same student", () => {
  it("keeps pushing without baseRev, and the newer build learns of it through the 409", async () => {
    const { env } = makeEnv();
    const signIn = async () =>
      (
        (await workerFetch(env, "/auth/intra", { method: "POST", body: { token: await intraToken() }, origin: PAGE_ORIGIN }))
          .json as { token: string }
      ).token;
    const oldBuild = { login: LOGIN, token: await signIn() };
    const newBuild = { login: LOGIN, token: await signIn() };

    const pulled = await workerFetch(env, "/api/v1/private/settings", { auth: newBuild });
    const rev = (pulled.json as { rev: number }).rev;
    // the old build's push: no baseRev, the text answer, and the rev moves
    const old = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      body: { settings: { THEME: "light" } },
      auth: oldBuild,
    });
    expect(old.text).toBe("Saved");
    const behind = await workerFetch(env, "/api/v1/private/settings", {
      method: "POST",
      body: { settings: { THEME: "dark" }, baseRev: rev },
      auth: newBuild,
    });
    expect(behind.status).toBe(409);
    expect(behind.error).toBe("conflict");
    // the old build's session count still counts both browsers
    const meta = await workerFetch(env, "/api/v1/private/settings?fields=meta", { auth: oldBuild });
    expect((meta.json as { activeSessions: number }).activeSessions).toBe(2);
  });
});

describe("1.17.1 error answers", () => {
  it("always carry a message it can show, with CORS", async () => {
    const { env } = makeEnv();
    const hash = await hashLogin(LOGIN);
    const cases: [string, Options1171][] = [
      ["/api/v1/private/settings", { auth: { login: LOGIN, token: "nope" } }],
      ["/api/v1/private/settings?fields=meta", { auth: { login: LOGIN, token: "nope" } }],
      ["/api/v1/private/calendar/update", { method: "POST", body: { ics: "x" }, auth: { login: LOGIN, token: "nope" } }],
      ["/api/v1/private/images?slot=avatar", { method: "PUT", auth: { login: LOGIN, token: "nope" } }],
      ["/api/v1/private/subjects/state?slugs=libft", { auth: { login: LOGIN, token: "nope" } }],
      [`/api/v1/public/visuals?login=${hash.slice(1)}`, {}],
      ["/auth/intra", { method: "POST", body: { token: "short" } }],
      ["/api/v1/private/friends/data", {}],
    ];
    for (const [path, options] of cases) {
      const res = await workerFetch(env, path, options);
      expect(res.ok, path).toBe(false);
      expect(typeof shown(res), path).toBe("string");
      expect(shown(res).length, path).toBeGreaterThan(0);
      expectCors(res);
    }
  });

  it("keep a private 401 a 401, never the 404 that 1.17.1 also reads as signed out", async () => {
    const { env } = makeEnv();
    for (const path of [
      "/api/v1/private/settings",
      "/api/v1/private/calendar/token",
      "/api/v1/private/subjects/state?slugs=a",
    ]) {
      const res = await workerFetch(env, path, { auth: { login: LOGIN, token: "unknown" } });
      expect(res.status, path).toBe(401);
    }
    // deleteProfileImage() takes a 404 for "already gone": a revoked session must not read so
    for (const method of ["DELETE", "POST"]) {
      const res = await workerFetch(env, "/api/v1/private/images?slot=avatar", {
        method,
        body: method === "POST" ? "x" : undefined,
        auth: { login: LOGIN, token: "unknown" },
      });
      expect(res.status, method).toBe(401);
    }
  });
});
