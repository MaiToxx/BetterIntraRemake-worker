import { Env, UserData } from "../types";
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
] as const;

const MAX_LOOK_STRING = 2048;

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
    }
  }
  return Object.keys(out).length > 0 ? out : null;
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
