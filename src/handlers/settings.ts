import { Env, UserData } from "../types";
import { deleteCalendarData } from "./calendar";
import {
  getBearerToken,
  getTokens,
  jsonRes,
  textRes,
  validateSession,
} from "../utils";

/**
 * Customize settings a user may publish on their profile (opt-in through
 * CUSTOM_SHARE_LOOK). Presentation only: fonts, size, scrollbar and the
 * free-form CSS never leave their author. The extension validates every
 * value again before using it.
 */
export const PUBLIC_LOOK_KEYS = [
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

export async function handlePublicVisuals(
  request: Request,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "GET") return textRes("Method not allowed", 405);

  const settings = existingData?.settings || {};

  return jsonRes({
    // Look published by the user for visitors of their profile (or null)
    look: publicLook(settings),

    // Public profile extras (bio, status, links, name style...) or null
    extras: publicExtras(settings),

    // Existing visual settings
    avatar: settings.PROFILE_IMAGE_URL || "",
    banner: settings.PROFILE_BANNER_URL || "",
    bannerMode: settings.PROFILE_BANNER_MODE || "fill",
    bannerColor: settings.PROFILE_BANNER_COLOR || "",
    background: settings.PROFILE_BACKGROUND_URL || "",
    backgroundMode: settings.PROFILE_BACKGROUND_MODE || "fill",
    backgroundColor: settings.PROFILE_BACKGROUND_COLOR || "",
    avatarBg: settings.PROFILE_AVATAR_BG || "transparent",
    decoration: settings.PROFILE_DECORATION || "none",
    avatarPosX: Number(settings.PROFILE_AVATAR_POSITION_X ?? 50),
    avatarPosY: Number(settings.PROFILE_AVATAR_POSITION_Y ?? 50),
    avatarScale: Number(settings.PROFILE_AVATAR_SCALE ?? 100),
    badgeBg: settings.PROFILE_BADGE_BG || "",

    // Theme settings (for profile card)
    theme: {
      profileColor: settings.LOGTIME_CALENDAR_COLOR,
    },

    // Public Logtime settings
    logtime: {
      calendarColor: settings.LOGTIME_CALENDAR_COLOR,
      labelsColor: settings.LOGTIME_LABELS_COLOR,
      emoji: settings.LOGTIME_EMOJI,
      emojiDivisor: settings.LOGTIME_EMOJI_DIVISOR,
      emojiRate: settings.LOGTIME_EMOJI_RATE,
      rainbowPalette: settings.LOGTIME_RAINBOW_PALETTE,
    },
  });
}

export async function handlePrivateSettings(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  const authHeader = getBearerToken(request);
  if (!authHeader) return textRes("Missing Authorization Token", 401);

  if (!existingData) return textRes("User not found", 404);

  if (!validateSession(existingData, authHeader)) {
    return textRes("Unauthorized: Invalid Session Token", 401);
  }

  const tokensList = getTokens(existingData);

  if (request.method === "GET") {
    return jsonRes({
      settings: existingData.settings || {},
      activeSessions: tokensList.length,
      discordId: existingData.discordId,
      discordUsername: existingData.discordUsername,
    });
  }

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return textRes("Invalid JSON body", 400);
    }

    if (typeof body?.settings !== "object" || body.settings === null) {
      return textRes("Invalid settings payload", 400);
    }

    const settingsToSave = {
      ...(existingData.settings || {}),
      ...body.settings,
    };

    // The namespace shares 1,000 KV writes a day, and past the limit every
    // put throws until midnight UTC (sign-ins included). A push that changes
    // nothing (hub reload with auto-push, Push with no edit, a control set to
    // its current value) must not spend one.
    if (
      JSON.stringify(settingsToSave) ===
      JSON.stringify(existingData.settings || {})
    ) {
      return textRes("Saved");
    }

    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList,
        settings: settingsToSave,
        discordId: existingData.discordId,
        discordUsername: existingData.discordUsername,
        discordQuietEnabled: existingData.discordQuietEnabled,
        discordQuietStart: existingData.discordQuietStart,
        discordQuietEnd: existingData.discordQuietEnd,
        discordQuietTimezone: existingData.discordQuietTimezone,
        tokenBroken: existingData.tokenBroken,
      }),
    );
    return textRes("Saved");
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    if (url.searchParams.get("all") === "true") {
      // Calendar first: if it fails the user record, and so the session
      // needed to retry, is still there.
      await deleteCalendarData(env, loginParam, existingData.settings);
      await env.BETTER_INTRA_KV.delete(loginParam);
      return textRes("All cloud data deleted");
    }
    await env.BETTER_INTRA_KV.put(
      loginParam,
      JSON.stringify({
        sessionTokens: tokensList.filter((t) => t !== authHeader),
        settings: existingData.settings || {},
        discordId: existingData.discordId,
        discordUsername: existingData.discordUsername,
        discordQuietEnabled: existingData.discordQuietEnabled,
        discordQuietStart: existingData.discordQuietStart,
        discordQuietEnd: existingData.discordQuietEnd,
        discordQuietTimezone: existingData.discordQuietTimezone,
        tokenBroken: existingData.tokenBroken,
      }),
    );
    return textRes("Session removed");
  }

  return textRes("Method not allowed", 405);
}
