import { Env, UserData } from "../types";
import { deleteCalendarData } from "./calendar";
import { deleteUserImages } from "./images";
import { budgetRes, spendKvWrite } from "../budget";
import { clientKey, rateLimited, tooManyRes } from "../rate-limit";
import {
  deletePublicRowStatement,
  readPublicRows,
  refreshPublicRow,
  writePublicRow,
} from "../public-visuals";
import {
  authenticate,
  countSessions,
  deleteAllSessions,
  deleteSession,
  recordLoader,
  type RecordSource,
} from "../sessions";
import {
  errorRes,
  isLoginHash,
  jsonRes,
  KV_BUSY,
  kvBusyRes,
  methodNotAllowedRes,
  readJsonBody,
  retryKvBusy,
  textRes,
  unauthorizedRes,
} from "../utils";

/**
 * Customize settings a user may publish on their profile, published while
 * the last push said CUSTOM_SHARE_LOOK: true (the extension's default since
 * 1.14.0). Presentation only: fonts, size, scrollbar and the free-form CSS
 * never leave their author. The extension validates every
 * value again before using it.
 */
export const PUBLIC_LOOK_KEYS = [
  // the theme preset (a name the extension checks against its own list)
  "PROFILE_THEME_PRESET",
  "CUSTOM_ACCENT_ENABLED",
  "CUSTOM_ACCENT_COLOR",
  "CUSTOM_ACCENT_GRADIENT",
  "CUSTOM_ACCENT_COLOR_2",
  "CUSTOM_RADIUS",
  "CUSTOM_THEME_ENABLED",
  "CUSTOM_THEME_BG",
  "CUSTOM_THEME_CARD",
  "CUSTOM_THEME_TEXT",
  "CUSTOM_PAGE_BG_URL",
  "CUSTOM_PAGE_BG_DIM",
  "CUSTOM_PAGE_BG_PRESET",
  "CUSTOM_BG_ANIMATE",
  "CUSTOM_CARD_OPACITY",
  "CUSTOM_CARD_STYLE",
  "CUSTOM_AVATAR_SHAPE",
  "CUSTOM_CARD_BORDER_MODE",
  "CUSTOM_CARD_BORDER_COLOR",
  "CUSTOM_CARD_BORDER_WIDTH",
  "CUSTOM_CARD_GLOW",
  "CUSTOM_CARD_TITLE_MODE",
  "CUSTOM_CARD_TITLE_COLOR",
  "CUSTOM_CARDS",
] as const;

const MAX_LOOK_STRING = 2048;
/** Only object-valued look key (per-card colours); bounded like the strings. */
const OBJECT_KEYS = new Set<string>(["CUSTOM_CARDS"]);

/**
 * Bounds of a settings push. The whole record is read by the settings routes
 * and by /api/v1/public/visuals, so a bloated record slows every visitor of
 * the profile and every friend row: the caps stop abuse,
 * not real use. A default record is about 4 KB, but real ones are larger:
 * a custom stylesheet goes past 8 KB, and each saved Customize preset (up to
 * 20) carries a copy of it, so 20 presets over a 3 KB stylesheet are about
 * 87 KB. Past a cap the push is refused whole and the student's cloud copy
 * and public look stop updating, so both leave room: 64 KB for one string
 * (the stylesheet), 256 KB for the record.
 */
export const MAX_SETTINGS_BYTES = 256 * 1024;
export const MAX_SETTING_STRING = 64 * 1024;

/** Keep in sync with the extension's public-visuals sanitizer bounds. */
const MAX_VISUAL_URL = 2048;
const MAX_VISUAL_WORD = 64;

/** Bulk get of the visuals route: one KV read per key still, one invocation. */
export const MAX_VISUALS_LOGINS = 50;

/**
 * Visuals hardly change and the extension caches them for minutes anyway:
 * letting the browser reuse a response across the friend rows and profile
 * views of the same few minutes costs nothing.
 */
const VISUALS_CACHE = { "Cache-Control": "public, max-age=300" };

export function publicLook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  if (settings.CUSTOM_SHARE_LOOK !== true) return null;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_LOOK_KEYS) {
    const v = settings[key];
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      out[key] = v;
    } else if (typeof v === "string" && v.length <= MAX_LOOK_STRING) {
      out[key] = v;
    } else if (
      OBJECT_KEYS.has(key) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      JSON.stringify(v).length <= MAX_LOOK_STRING
    ) {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * "Public profile" extras a user adds to their own profile page (bio, status,
 * links, name style, avatar frame, particle effect...), seen by every visitor.
 *
 * This list is a copy of EXTRAS_KEYS in the extension
 * (src/features/profile/extras/extras.ts): the worker cannot import from the
 * extension, so both lists must be kept in sync by hand. Nothing outside this
 * list is ever published through `extras`.
 */
export const PUBLIC_EXTRAS_KEYS = [
  "PROFILE_PUB_ENABLED",
  "PROFILE_PUB_BIO",
  "PROFILE_PUB_STATUS_EMOJI",
  "PROFILE_PUB_STATUS_TEXT",
  "PROFILE_PUB_PRONOUNS",
  "PROFILE_PUB_FLAIR",
  "PROFILE_PUB_GREETING",
  "PROFILE_PUB_LINK_GITHUB",
  "PROFILE_PUB_LINK_GITLAB",
  "PROFILE_PUB_LINK_LINKEDIN",
  "PROFILE_PUB_LINK_WEBSITE",
  "PROFILE_PUB_LINK_DISCORD",
  "PROFILE_PUB_NAME_STYLE",
  "PROFILE_PUB_NAME_COLOR",
  "PROFILE_PUB_NAME_COLOR_2",
  "PROFILE_PUB_NAME_FONT",
  "PROFILE_PUB_FRAME",
  "PROFILE_PUB_FRAME_COLOR",
  "PROFILE_PUB_FRAME_COLOR_2",
  "PROFILE_PUB_LEVEL_STYLE",
  "PROFILE_PUB_LEVEL_COLOR",
  "PROFILE_PUB_LEVEL_COLOR_2",
  "PROFILE_PUB_BANNER_GRADIENT",
  "PROFILE_PUB_BANNER_DIM",
  "PROFILE_PUB_BANNER_BLUR",
  "PROFILE_PUB_CARD_GLOW",
  "PROFILE_PUB_EFFECT",
  "PROFILE_PUB_EFFECT_INTENSITY",
  "PROFILE_PUB_EFFECT_TINT",
  "PROFILE_PUB_EFFECT_COLOR",
] as const;

/** Far above every limit of the extension's sanitizer (longest: a link URL). */
const MAX_EXTRAS_STRING = 512;

/**
 * Extras published for the visitors of a profile, or null. Published unless
 * the owner switched them off (PROFILE_PUB_ENABLED === false). The worker only
 * bounds the payload (known keys, primitive values, short strings): the
 * extension validates every value again before using it.
 */
export function publicExtras(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  if (settings.PROFILE_PUB_ENABLED === false) return null;
  const out: Record<string, unknown> = {};
  let published = 0;
  for (const key of PUBLIC_EXTRAS_KEYS) {
    const v = settings[key];
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      out[key] = v;
    } else if (typeof v === "string" && v.length > 0 && v.length <= MAX_EXTRAS_STRING) {
      out[key] = v;
    } else {
      continue;
    }
    if (key !== "PROFILE_PUB_ENABLED") published++;
  }
  // The switch alone says nothing about the profile
  return published > 0 ? out : null;
}

/** `v` when it is a string no longer than `max`, else `fallback`. */
function str(v: unknown, max: number, fallback = ""): string {
  return typeof v === "string" && v.length <= max && v.length > 0 ? v : fallback;
}

/** `v` as a finite number, else `fallback`. */
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v ?? NaN);
  return Number.isFinite(n) ? n : fallback;
}

function optStr(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * What every visitor of a profile receives. Every field is bounded here, not
 * only at push time: a record stored by an older worker, or by a client that
 * bypassed the push limits, must not be re-served to everyone as is.
 */
export function publicVisuals(existingData: UserData | null) {
  const settings = existingData?.settings || {};
  return {
    // Look published by the user for visitors of their profile (or null)
    look: publicLook(settings),

    // Public profile extras (bio, status, links, name style...) or null
    extras: publicExtras(settings),

    avatar: str(settings.PROFILE_IMAGE_URL, MAX_VISUAL_URL),
    banner: str(settings.PROFILE_BANNER_URL, MAX_VISUAL_URL),
    bannerMode: str(settings.PROFILE_BANNER_MODE, MAX_VISUAL_WORD, "fill"),
    bannerColor: str(settings.PROFILE_BANNER_COLOR, MAX_VISUAL_WORD),
    background: str(settings.PROFILE_BACKGROUND_URL, MAX_VISUAL_URL),
    backgroundMode: str(settings.PROFILE_BACKGROUND_MODE, MAX_VISUAL_WORD, "fill"),
    backgroundColor: str(settings.PROFILE_BACKGROUND_COLOR, MAX_VISUAL_WORD),
    avatarBg: str(settings.PROFILE_AVATAR_BG, MAX_VISUAL_WORD, "transparent"),
    decoration: str(settings.PROFILE_DECORATION, MAX_VISUAL_WORD, "none"),
    avatarPosX: num(settings.PROFILE_AVATAR_POSITION_X, 50),
    avatarPosY: num(settings.PROFILE_AVATAR_POSITION_Y, 50),
    avatarScale: num(settings.PROFILE_AVATAR_SCALE, 100),
    badgeBg: str(settings.PROFILE_BADGE_BG, MAX_VISUAL_WORD),

    // Theme settings (for profile card)
    theme: {
      profileColor: optStr(settings.LOGTIME_CALENDAR_COLOR, MAX_VISUAL_WORD),
    },

    // Public Logtime settings: display values only. LOGTIME_EMOJI_RATE is
    // not one of them: the hub long labelled it "Hourly Earning", so it can
    // hold a student's real pay, and visitors count with their own rate.
    logtime: {
      calendarColor: optStr(settings.LOGTIME_CALENDAR_COLOR, MAX_VISUAL_WORD),
      labelsColor: optStr(settings.LOGTIME_LABELS_COLOR, MAX_VISUAL_WORD),
      emoji: optStr(settings.LOGTIME_EMOJI, MAX_VISUAL_WORD),
      emojiDivisor: optNum(settings.LOGTIME_EMOJI_DIVISOR),
      rainbowPalette: optStr(settings.LOGTIME_RAINBOW_PALETTE, MAX_VISUAL_URL),
    },
  };
}

/**
 * Keys publicVisuals() reads besides the look (CUSTOM_SHARE_LOOK and
 * PUBLIC_LOOK_KEYS) and the extras (PUBLIC_EXTRAS_KEYS). A test runs
 * publicVisuals() over a Proxy and fails on any key read that is not in
 * PUBLIC_VISUAL_KEYS: one missing here would be served from D1 as its default.
 */
const PUBLIC_PROFILE_KEYS = [
  "PROFILE_IMAGE_URL",
  "PROFILE_BANNER_URL",
  "PROFILE_BANNER_MODE",
  "PROFILE_BANNER_COLOR",
  "PROFILE_BACKGROUND_URL",
  "PROFILE_BACKGROUND_MODE",
  "PROFILE_BACKGROUND_COLOR",
  "PROFILE_AVATAR_BG",
  "PROFILE_DECORATION",
  "PROFILE_BADGE_BG",
  "LOGTIME_CALENDAR_COLOR",
  "LOGTIME_LABELS_COLOR",
  "LOGTIME_EMOJI",
  "LOGTIME_EMOJI_DIVISOR",
  "LOGTIME_RAINBOW_PALETTE",
] as const;

/** Read with num(), which turns any value into a number (Number("120")). */
const PUBLIC_NUMBER_KEYS = new Set<string>([
  "PROFILE_AVATAR_POSITION_X",
  "PROFILE_AVATAR_POSITION_Y",
  "PROFILE_AVATAR_SCALE",
]);

/** Every settings key publicVisuals() reads: what public_visuals stores. */
export const PUBLIC_VISUAL_KEYS: readonly string[] = [
  "CUSTOM_SHARE_LOOK",
  ...PUBLIC_LOOK_KEYS,
  ...PUBLIC_EXTRAS_KEYS,
  ...PUBLIC_PROFILE_KEYS,
  ...PUBLIC_NUMBER_KEYS,
];

/** The longest string any public field accepts (URLs, look strings). */
const MAX_PUBLIC_STRING = Math.max(MAX_LOOK_STRING, MAX_VISUAL_URL, MAX_EXTRAS_STRING);

/**
 * The part of `settings` that publicVisuals() uses, as the public_visuals
 * row keeps it (src/public-visuals.ts). publicVisuals() of the subset is the
 * same JSON, byte for byte, as publicVisuals() of the whole settings (a test
 * checks it over ill-typed and oversize values): a value is only left out
 * when every reader of its key would drop it anyway (a string longer than
 * any field accepts, an object outside OBJECT_KEYS, an array, null), and a
 * num() key keeps the number num() makes of it. That bounds a row to a few
 * KB whatever the record holds, and the copy is the same whether a visitor
 * is served from D1 or from KV.
 */
export function publicSubset(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_VISUAL_KEYS) {
    const v = settings[key];
    if (PUBLIC_NUMBER_KEYS.has(key)) {
      const n = typeof v === "number" ? v : Number(v ?? NaN);
      if (Number.isFinite(n)) out[key] = n;
    } else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      out[key] = v;
    } else if (typeof v === "string" && v.length <= MAX_PUBLIC_STRING) {
      out[key] = v;
    } else if (
      OBJECT_KEYS.has(key) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      JSON.stringify(v).length <= MAX_LOOK_STRING
    ) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * GET /api/v1/public/visuals?login=<hash>. `source` is what to render: the
 * router passes the login's public_visuals row, falling back to its KV
 * record (see publicRecord); tests may pass a record.
 */
export async function handlePublicVisuals(
  request: Request,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();
  return jsonRes(publicVisuals(await recordLoader(source)()), 200, VISUALS_CACHE);
}

/**
 * `logins` query parameter of the batch visuals route as KV keys: trimmed,
 * deduplicated, every one a login hash. Null when one is not, or when there
 * are more than MAX_VISUALS_LOGINS (the friends list is capped well below).
 */
export function parseVisualsLogins(raw: string): string[] | null {
  const hashes = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (hashes.length === 0 || hashes.length > MAX_VISUALS_LOGINS) return null;
  if (!hashes.every(isLoginHash)) return null;
  return hashes;
}

/**
 * GET /api/v1/public/visuals?logins=h1,h2,... -> { visuals: { h1: {...} } }
 *
 * One invocation for the whole friends list instead of one per friend. One
 * D1 query for the logins that have a public_visuals row, then one bulk KV
 * read for the others only. KV bills one read per key, missing keys
 * included, so a call can still cost up to 50 reads (made-up hashes have no
 * row): the route is limited per IP ("visuals" bucket, see
 * src/rate-limit.ts) before any read. An unknown hash gets the same defaults
 * as the single form, so the batch says nothing about who has an account.
 */
export async function handlePublicVisualsBatch(
  request: Request,
  env: Env,
  raw: string,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();
  const hashes = parseVisualsLogins(raw);
  if (!hashes) {
    return errorRes(
      "bad_request",
      `logins must be 1 to ${MAX_VISUALS_LOGINS} login hashes`,
      400,
    );
  }
  if (await rateLimited(env, "visuals", clientKey(request.headers.get("CF-Connecting-IP")))) {
    return tooManyRes();
  }
  const rows = await readPublicRows(env, hashes);
  const missing = hashes.filter((h) => !rows?.has(h));
  const records =
    missing.length > 0
      ? await env.BETTER_INTRA_KV.get<UserData>(missing, { type: "json" })
      : new Map<string, UserData | null>();
  const visuals: Record<string, ReturnType<typeof publicVisuals>> = {};
  for (const hash of hashes) {
    const row = rows?.get(hash);
    visuals[hash] = publicVisuals(row ? { settings: row } : (records.get(hash) ?? null));
  }
  return jsonRes({ visuals }, 200, VISUALS_CACHE);
}

/**
 * The 413 of a push, as JSON the extension can act on: `key` names the
 * setting to shorten (null when the body was refused before it was parsed),
 * `max` the cap it went over (characters of the string or of the stored
 * record as JSON, bytes of the request body).
 */
export interface TooLargeBody {
  error: "too_large";
  key: string | null;
  max: number;
  message: string;
}

function tooLargeRes(key: string | null, max: number, message: string): Response {
  const body: TooLargeBody = {
    error: "too_large",
    key: key === null ? null : key.slice(0, 64),
    max,
    message,
  };
  return jsonRes(body, 413);
}

const kb = (bytes: number) => `${bytes / 1024} KB`;

const bodyTooLargeRes = () =>
  tooLargeRes(null, MAX_SETTINGS_BYTES, `Settings too large (max ${kb(MAX_SETTINGS_BYTES)})`);

/** Response to a push, or null when every value fits. */
function checkSettingValues(settings: Record<string, unknown>): Response | null {
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === "string" && value.length > MAX_SETTING_STRING) {
      return tooLargeRes(
        key,
        MAX_SETTING_STRING,
        `Setting ${key.slice(0, 64)} too large (max ${kb(MAX_SETTING_STRING)})`,
      );
    }
  }
  return null;
}

/** The key whose value takes the most room in `settings`, as stored. */
function largestKey(settings: Record<string, unknown>): string | null {
  let largest: string | null = null;
  let size = -1;
  for (const [key, value] of Object.entries(settings)) {
    const n = JSON.stringify(value)?.length ?? 0;
    if (n > size) {
      largest = key;
      size = n;
    }
  }
  return largest;
}

function recordTooLargeRes(settings: Record<string, unknown>): Response {
  const key = largestKey(settings);
  return tooLargeRes(
    key,
    MAX_SETTINGS_BYTES,
    `Settings too large (max ${kb(MAX_SETTINGS_BYTES)}); largest: ${key?.slice(0, 64) ?? "?"}`,
  );
}

/**
 * The record to store with new settings. The legacy session fields go:
 * sessions live in D1 (src/sessions.ts), whose marker the caller's session
 * check wrote before any write can happen, and a token must not stay in
 * clear. Any other field is kept.
 */
function withSettings(
  record: UserData | null,
  settings: Record<string, unknown>,
): UserData {
  const { sessionTokens: _tokens, sessionToken: _token, ...rest } = record ?? {};
  return { ...rest, settings };
}

/** The record's settings revision; 0 for a record from before revisions. */
export function revOf(record: UserData | null): number {
  const rev = record?.settingsRev;
  return typeof rev === "number" && Number.isFinite(rev) ? rev : 0;
}

/**
 * The push named the revision it started from and the stored one is newer:
 * another browser wrote since this one last synced. Nothing is written; the
 * extension offers to pull first, or to push anyway (without baseRev).
 */
const conflictRes = (rev: number) =>
  errorRes(
    "conflict",
    "Settings changed in another browser since this one last synced",
    409,
    {},
    { rev },
  );

export async function handlePrivateSettings(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  const record = recordLoader(source);
  const session = await authenticate(request, env, loginParam, record);
  if (!session) return unauthorizedRes();

  if (request.method === "GET") {
    const url = new URL(request.url);
    const [data, activeSessions] = await Promise.all([
      record(),
      countSessions(env, loginParam),
    ]);
    // The hub's account card: the session count and the revision (kept in
    // the record, so this reads it), without the settings blob.
    if (url.searchParams.get("fields") === "meta") {
      return jsonRes({ activeSessions, discordId: null, rev: revOf(data) });
    }
    return jsonRes({
      settings: data?.settings || {},
      activeSessions,
      discordId: null,
      rev: revOf(data),
    });
  }

  if (request.method === "POST") {
    return pushSettings(request, env, loginParam, record);
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      if (await rateLimited(env, "write", loginParam)) return tooManyRes();
      // Calendar first, then the D1 rows, the images and the record, and the
      // sessions last: if a step fails, the session needed to retry is still
      // there.
      await deleteCalendarData(env, loginParam);
      // The users row (login hash, first sign-in date) feeds the public
      // stats; "Wipe all data" must take the student out of them too. The
      // public copy of the settings goes with them, before the record, so
      // visitors never see a wiped look. The day's kv_write_budget rows
      // stay (two days at most): wiping must not reset the daily cap.
      await env.better_intra_d1.batch([
        env.better_intra_d1.prepare("DELETE FROM users WHERE hash = ?").bind(loginParam),
        deletePublicRowStatement(env, loginParam),
      ]);
      // Uploaded images: after the D1 steps, which are the ones that can
      // fail, so a retry finds nothing half-deleted.
      await deleteUserImages(env, loginParam);
      await env.BETTER_INTRA_KV.delete(loginParam);
      await deleteAllSessions(env, loginParam);
      return textRes("All cloud data deleted");
    }
    // Signing out is not rate limited: it shared the 10-a-minute write bucket,
    // so after a burst of uploads the sign-out got a 429 while the extension
    // dropped its copy of the token, which then stayed valid here. It cannot
    // be looped: the token is gone after one call, and the next one is a 401.
    // One D1 delete: the KV record (settings) is not touched any more.
    await deleteSession(env, session);
    return textRes("Session removed");
  }

  return methodNotAllowedRes();
}

/**
 * POST {settings, baseRev?}: merges `settings` into the record.
 *
 * `baseRev` is the revision the browser last pulled or pushed. Without it
 * (builds up to 1.17.1, and pushes of a few keys) the merge is written as
 * before and the answer stays the text "Saved". With it, a stored revision
 * newer than baseRev is a 409 and nothing is written, even when the push
 * would change nothing: a browser that never pulled used to overwrite every
 * key another one had pushed, the friends list and the public avatar
 * included. A stored revision older than baseRev is this browser's own last
 * write read back stale by this location (KV may serve a copy up to 60 s
 * old), not a conflict. Success is JSON {"ok":true,"rev":n}: the new
 * revision, or the stored one when nothing changed (never newer than
 * baseRev then, so it never hides another browser's write).
 */
async function pushSettings(
  request: Request,
  env: Env,
  loginParam: string,
  record: () => Promise<UserData | null>,
): Promise<Response> {
  const body = await readJsonBody<{ settings?: unknown; baseRev?: unknown } | null>(
    request,
    MAX_SETTINGS_BYTES,
    bodyTooLargeRes,
  );
  if (!body.ok) return body.response;

  const incoming = body.value?.settings;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return errorRes("bad_request", "Invalid settings payload", 400);
  }
  const rawBase = body.value?.baseRev;
  let baseRev: number | null = null;
  if (rawBase !== undefined && rawBase !== null) {
    if (typeof rawBase !== "number" || !Number.isFinite(rawBase)) {
      return errorRes("bad_request", "baseRev must be a number", 400);
    }
    baseRev = rawBase;
  }
  const tooLong = checkSettingValues(incoming as Record<string, unknown>);
  if (tooLong) return tooLong;

  const saved = (rev: number) =>
    baseRev === null ? textRes("Saved") : jsonRes({ ok: true, rev });
  // Spent once per push, not per attempt: a KV refusal wrote nothing.
  let counted = false;
  // The public subset this request stored in D1, if it did.
  let publicWritten: string | null = null;
  // The public subset of the record the last attempt read: what stays
  // stored when no attempt manages to write.
  let lastStoredPublic: string | null = null;
  // A retry that ends without writing (the record changed in between): the
  // public row this request wrote must match the record that stays.
  const syncPublicRow = async (storedPublic: string) => {
    if (publicWritten !== null && publicWritten !== storedPublic) {
      await writePublicRow(env, loginParam, storedPublic);
    }
  };
  // The put failed after the row was written (KV refused the key twice, or
  // threw its daily limit): visitors would be served a look the record never
  // stored, and for good if the student then went back to the stored one,
  // since that push changes nothing public next to the record. Best effort:
  // the push's own failure is what the client must see.
  const unwindPublicRow = async () => {
    if (lastStoredPublic === null) return;
    try {
      await syncPublicRow(lastStoredPublic);
    } catch (e) {
      console.warn(`[settings] public row not put back after a failed write: ${e}`);
    }
  };

  let outcome: Response | typeof KV_BUSY;
  try {
    outcome = await retryKvBusy(async (again) => {
      // The retry reads the record afresh: a push that landed in between is
      // merged, never rolled back by a re-put of the first read.
      const data = again
        ? await env.BETTER_INTRA_KV.get<UserData>(loginParam, { type: "json" })
        : await record();
      const stored = data?.settings || {};
      const storedRev = revOf(data);
      const settingsToSave = {
        ...stored,
        ...(incoming as Record<string, unknown>),
      };
      const serialized = JSON.stringify(settingsToSave);
      const storedPublic = JSON.stringify(publicSubset(stored));
      lastStoredPublic = storedPublic;

      // First, and before the limiter: a refused push must not use up a write
      // slot. Before the no-op check too: a push of a few keys that happen to
      // match would otherwise be answered the other browser's revision, which
      // its sender cannot tell from its own write; adopting it, its next full
      // push would overwrite what that browser pushed.
      if (baseRev !== null && storedRev > baseRev) {
        await syncPublicRow(storedPublic);
        return conflictRes(storedRev);
      }
      // The namespace shares 1,000 KV writes a day, and past the limit every
      // put throws until midnight UTC. A push that changes nothing (hub reload
      // with auto-push, Push with no edit, a control set to its current value)
      // must not spend one, nor count against the limiter. A record that still
      // lists legacy tokens keeps them until a push really writes: they are
      // dead since the copy to D1, and removing them alone would cost a write.
      if (serialized === JSON.stringify(stored)) {
        await syncPublicRow(storedPublic);
        return saved(storedRev);
      }
      // The merged record is what gets stored: an existing large record must
      // not be topped up past the cap one small push at a time.
      if (serialized.length > MAX_SETTINGS_BYTES) {
        await syncPublicRow(storedPublic);
        return recordTooLargeRes(settingsToSave);
      }

      if (!counted) {
        if (await rateLimited(env, "write", loginParam)) return tooManyRes();
        if (!(await spendKvWrite(env, loginParam))) return budgetRes();
        counted = true;
      }

      // The public copy first, and only when what visitors see changes (most
      // pushes do not): if D1 fails nothing is written and a retry redoes both;
      // if KV fails afterwards, the retry finds the old record and writes both
      // again, and a put that fails for good puts the row back
      // (unwindPublicRow). Written after the put, a failure would leave the
      // row stale behind the no-op return above.
      const nextPublic = JSON.stringify(publicSubset(settingsToSave));
      if (
        nextPublic !== storedPublic ||
        (publicWritten !== null && publicWritten !== nextPublic)
      ) {
        await writePublicRow(env, loginParam, nextPublic);
        publicWritten = nextPublic;
      } else if (await refreshPublicRow(env, loginParam, nextPublic)) {
        // the row was not what the record read says: see refreshPublicRow
        publicWritten = nextPublic;
      }

      // Settings only: the push no longer carries the session list it read,
      // which could drop a session opened since, or revive a removed one.
      const rev = Math.max(Date.now(), storedRev + 1);
      await env.BETTER_INTRA_KV.put(
        loginParam,
        JSON.stringify({ ...withSettings(data, settingsToSave), settingsRev: rev }),
      );
      return saved(rev);
    });
  } catch (e) {
    await unwindPublicRow();
    throw e;
  }
  if (outcome === KV_BUSY) {
    await unwindPublicRow();
    return kvBusyRes();
  }
  return outcome;
}
