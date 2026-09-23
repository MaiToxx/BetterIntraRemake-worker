import { Env, UserData } from "../types";
import { deleteCalendarData } from "./calendar";
import { deleteUserImages } from "./images";
import { rateLimited, tooManyRes } from "../rate-limit";
import {
  getBearerToken,
  getTokens,
  isLoginHash,
  jsonRes,
  readJsonBody,
  requireSession,
  textRes,
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
 * Bounds of a settings push. The whole record is read on every request that
 * names the user, /api/v1/public/visuals included, so a bloated record slows
 * every visitor of the profile and every friend row: the caps stop abuse,
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

    // Public Logtime settings
    logtime: {
      calendarColor: optStr(settings.LOGTIME_CALENDAR_COLOR, MAX_VISUAL_WORD),
      labelsColor: optStr(settings.LOGTIME_LABELS_COLOR, MAX_VISUAL_WORD),
      emoji: optStr(settings.LOGTIME_EMOJI, MAX_VISUAL_WORD),
      emojiDivisor: optNum(settings.LOGTIME_EMOJI_DIVISOR),
      emojiRate: optNum(settings.LOGTIME_EMOJI_RATE),
      rainbowPalette: optStr(settings.LOGTIME_RAINBOW_PALETTE, MAX_VISUAL_URL),
    },
  };
}

export async function handlePublicVisuals(
  request: Request,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  return jsonRes(publicVisuals(existingData), 200, VISUALS_CACHE);
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
 * One invocation for the whole friends list instead of one per friend. KV
 * bills one read per key either way, missing keys included: one call costs
 * up to 50 reads, so the route is limited per IP ("visuals" bucket, see
 * src/rate-limit.ts) before the bulk read. An unknown hash gets the same
 * defaults as the single form, so the batch says nothing about who has an
 * account.
 */
export async function handlePublicVisualsBatch(
  request: Request,
  env: Env,
  raw: string,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);
  const hashes = parseVisualsLogins(raw);
  if (!hashes) {
    return textRes(
      `logins must be 1 to ${MAX_VISUALS_LOGINS} login hashes`,
      400,
    );
  }
  if (await rateLimited(env, "visuals", request.headers.get("CF-Connecting-IP"))) {
    return tooManyRes();
  }
  const records = await env.BETTER_INTRA_KV.get<UserData>(hashes, {
    type: "json",
  });
  const visuals: Record<string, ReturnType<typeof publicVisuals>> = {};
  for (const hash of hashes) {
    visuals[hash] = publicVisuals(records.get(hash) ?? null);
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

export async function handlePrivateSettings(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const denied = requireSession(request, existingData);
  if (denied) return denied;
  // requireSession guarantees both
  const record = existingData as UserData;
  const authHeader = getBearerToken(request) as string;

  const tokensList = getTokens(record);

  if (request.method === "GET") {
    const url = new URL(request.url);
    // The hub's account card only needs the session count: the settings blob
    // is what makes the record large.
    if (url.searchParams.get("fields") === "meta") {
      return jsonRes({ activeSessions: tokensList.length, discordId: null });
    }
    return jsonRes({
      settings: record.settings || {},
      activeSessions: tokensList.length,
      discordId: null,
    });
  }

  if (request.method === "POST") {
    const body = await readJsonBody<{ settings?: unknown }>(
      request,
      MAX_SETTINGS_BYTES,
      bodyTooLargeRes,
    );
    if (!body.ok) return body.response;

    const incoming = body.value?.settings;
    if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
      return textRes("Invalid settings payload", 400);
    }
    const tooLong = checkSettingValues(incoming as Record<string, unknown>);
    if (tooLong) return tooLong;

    const settingsToSave = {
      ...(record.settings || {}),
      ...(incoming as Record<string, unknown>),
    };
    const serialized = JSON.stringify(settingsToSave);

    // The namespace shares 1,000 KV writes a day, and past the limit every
    // put throws until midnight UTC (sign-ins included). A push that changes
    // nothing (hub reload with auto-push, Push with no edit, a control set to
    // its current value) must not spend one, nor count against the limiter.
    if (serialized === JSON.stringify(record.settings || {})) {
      return textRes("Saved");
    }
    // The merged record is what gets stored: an existing large record must
    // not be topped up past the cap one small push at a time.
    if (serialized.length > MAX_SETTINGS_BYTES) return recordTooLargeRes(settingsToSave);

    if (await rateLimited(env, "write", loginParam)) return tooManyRes();

    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({ sessionTokens: tokensList, settings: settingsToSave }),
    );
    return textRes("Saved");
  }

  if (request.method === "DELETE") {
    if (await rateLimited(env, "write", loginParam)) return tooManyRes();
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      // Calendar first, then the D1 rows, then the record: if a step fails
      // the user record, and so the session needed to retry, is still there.
      await deleteCalendarData(env, loginParam, record.settings);
      // The users row (login hash, first sign-in date) feeds the public
      // stats; "Wipe all data" must take the student out of them too.
      await env.better_intra_d1
        .prepare("DELETE FROM users WHERE hash = ?")
        .bind(loginParam)
        .run();
      // Uploaded images: after the D1 steps, which are the ones that can
      // fail, so a retry finds nothing half-deleted.
      await deleteUserImages(env, loginParam);
      await env.BETTER_INTRA_KV.delete(loginParam);
      return textRes("All cloud data deleted");
    }
    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList.filter((t) => t !== authHeader),
        settings: record.settings || {},
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}
