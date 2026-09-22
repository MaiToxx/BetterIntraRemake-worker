import { describe, it, expect } from "vitest";
import {
  handlePublicVisuals,
  publicExtras,
  publicLook,
  PUBLIC_EXTRAS_KEYS,
} from "../src/handlers/settings";

const req = (method = "GET") =>
  new Request("https://worker.test/api/v1/public/visuals?login=abc", { method });

describe("publicLook", () => {
  it("returns null unless the user opted in", () => {
    expect(publicLook({ CUSTOM_ACCENT_COLOR: "#ff0000" })).toBeNull();
    expect(publicLook({ CUSTOM_SHARE_LOOK: "true", CUSTOM_ACCENT_COLOR: "#ff0000" })).toBeNull();
  });

  it("only exposes the publishable keys with primitive values", () => {
    const look = publicLook({
      CUSTOM_SHARE_LOOK: true,
      CUSTOM_ACCENT_ENABLED: true,
      CUSTOM_ACCENT_COLOR: "#ff0000",
      CUSTOM_PAGE_BG_DIM: 40,
      CUSTOM_CSS: "body { display: none }",
      CUSTOM_FONT: "mono",
      CUSTOM_FONT_SCALE: 120,
      CUSTOM_PAGE_BG_URL: "x".repeat(5000),
      CUSTOM_CARD_STYLE: { nested: true },
      CUSTOM_CARDS: { agenda: { bg: "#112233" } },
    });
    expect(look).toEqual({
      CUSTOM_ACCENT_ENABLED: true,
      CUSTOM_ACCENT_COLOR: "#ff0000",
      CUSTOM_PAGE_BG_DIM: 40,
      CUSTOM_CARDS: { agenda: { bg: "#112233" } },
    });
  });
});

describe("publicExtras", () => {
  it("publishes by default and returns null once the owner opted out", () => {
    expect(publicExtras({ PROFILE_PUB_BIO: "hello" })).toEqual({ PROFILE_PUB_BIO: "hello" });
    expect(publicExtras({ PROFILE_PUB_ENABLED: true, PROFILE_PUB_BIO: "hello" })).toEqual({
      PROFILE_PUB_ENABLED: true,
      PROFILE_PUB_BIO: "hello",
    });
    expect(
      publicExtras({
        PROFILE_PUB_ENABLED: false,
        PROFILE_PUB_BIO: "hello",
        PROFILE_PUB_EFFECT: "snow",
        PROFILE_PUB_CARD_GLOW: true,
      }),
    ).toBeNull();
  });

  it("keeps booleans, finite numbers and short strings only", () => {
    const extras = publicExtras({
      PROFILE_PUB_ENABLED: true,
      PROFILE_PUB_BIO: "x".repeat(512),
      PROFILE_PUB_GREETING: "x".repeat(513),
      PROFILE_PUB_STATUS_TEXT: "",
      PROFILE_PUB_CARD_GLOW: false,
      PROFILE_PUB_BANNER_DIM: 40,
      PROFILE_PUB_BANNER_BLUR: NaN,
      PROFILE_PUB_EFFECT_INTENSITY: Infinity,
      PROFILE_PUB_FLAIR: ["a", "b"],
      PROFILE_PUB_LINK_GITHUB: { href: "https://github.com/abc" },
      PROFILE_PUB_NAME_COLOR: null,
      PROFILE_PUB_FRAME: undefined,
    });
    expect(extras).toEqual({
      PROFILE_PUB_ENABLED: true,
      PROFILE_PUB_BIO: "x".repeat(512),
      PROFILE_PUB_CARD_GLOW: false,
      PROFILE_PUB_BANNER_DIM: 40,
    });
  });

  it("returns null when nothing (or only the switch) remains", () => {
    expect(publicExtras({})).toBeNull();
    expect(publicExtras({ PROFILE_PUB_ENABLED: true })).toBeNull();
    expect(
      publicExtras({
        PROFILE_PUB_ENABLED: true,
        PROFILE_PUB_BIO: "",
        PROFILE_PUB_GREETING: "x".repeat(513),
        PROFILE_PUB_FLAIR: ["a"],
        PROFILE_PUB_BANNER_DIM: NaN,
      }),
    ).toBeNull();
  });

  it("never leaks a key outside PUBLIC_EXTRAS_KEYS", () => {
    const extras = publicExtras({
      PROFILE_PUB_BIO: "hello",
      PROFILE_IMAGE_HISTORY: "https://img.test/old.png",
      CUSTOM_CSS: "body { display: none }",
      CLOUD_TOKEN: "secret-token",
      PROFILE_PUB_UNKNOWN: "nope",
      PROFILE_IMAGE_URL: "https://img.test/a.png",
    });
    expect(extras).toEqual({ PROFILE_PUB_BIO: "hello" });
    expect(JSON.stringify(extras)).not.toContain("secret-token");

    // Only leaked keys, nothing publishable: no extras at all
    expect(
      publicExtras({
        PROFILE_IMAGE_HISTORY: "https://img.test/old.png",
        CUSTOM_CSS: "body { display: none }",
        CLOUD_TOKEN: "secret-token",
      }),
    ).toBeNull();
  });

  it("publishes PROFILE_PUB_* keys only, without duplicates", () => {
    // Pinned copy of EXTRAS_KEYS in the extension
    // (src/features/profile/extras/extras.ts). The two lists are kept in
    // sync by hand: a change here means the extension must be updated too,
    // and this worker redeployed, before visitors see the new key.
    expect([...PUBLIC_EXTRAS_KEYS]).toEqual([
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
    ]);
    expect(PUBLIC_EXTRAS_KEYS[0]).toBe("PROFILE_PUB_ENABLED");
    expect(new Set(PUBLIC_EXTRAS_KEYS).size).toBe(PUBLIC_EXTRAS_KEYS.length);
    for (const key of PUBLIC_EXTRAS_KEYS) expect(key).toMatch(/^PROFILE_PUB_[A-Z0-9_]+$/);

    const all: Record<string, unknown> = {};
    for (const key of PUBLIC_EXTRAS_KEYS) all[key] = "v";
    expect(Object.keys(publicExtras(all) ?? {})).toEqual([...PUBLIC_EXTRAS_KEYS]);
  });
});

describe("handlePublicVisuals", () => {
  it("includes the look next to the existing visuals", async () => {
    const res = await handlePublicVisuals(req(), {
      settings: {
        PROFILE_IMAGE_URL: "https://img.test/a.png",
        CUSTOM_SHARE_LOOK: true,
        CUSTOM_PAGE_BG_PRESET: "ocean",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.avatar).toBe("https://img.test/a.png");
    expect(body.look).toEqual({ CUSTOM_PAGE_BG_PRESET: "ocean" });
  });

  it("returns look: null for unknown users and non-sharing users", async () => {
    const none = (await (await handlePublicVisuals(req(), null)).json()) as Record<string, unknown>;
    expect(none.look).toBeNull();
    const off = (await (
      await handlePublicVisuals(req(), { settings: { CUSTOM_PAGE_BG_PRESET: "ocean" } })
    ).json()) as Record<string, unknown>;
    expect(off.look).toBeNull();
  });

  it("carries the extras and keeps look and avatar", async () => {
    const res = await handlePublicVisuals(req(), {
      settings: {
        PROFILE_IMAGE_URL: "https://img.test/a.png",
        CUSTOM_SHARE_LOOK: true,
        CUSTOM_PAGE_BG_PRESET: "ocean",
        PROFILE_PUB_ENABLED: true,
        PROFILE_PUB_BIO: "hello",
        PROFILE_PUB_EFFECT: "snow",
        PROFILE_IMAGE_HISTORY: "https://img.test/old.png",
        CUSTOM_CSS: "body { display: none }",
        CLOUD_TOKEN: "secret-token",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("display: none");
    expect(text).not.toContain("old.png");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.avatar).toBe("https://img.test/a.png");
    expect(body.look).toEqual({ CUSTOM_PAGE_BG_PRESET: "ocean" });
    expect(body.extras).toEqual({
      PROFILE_PUB_ENABLED: true,
      PROFILE_PUB_BIO: "hello",
      PROFILE_PUB_EFFECT: "snow",
    });
  });

  it("returns extras: null for unknown users, opted-out users and empty extras", async () => {
    const none = (await (await handlePublicVisuals(req(), null)).json()) as Record<string, unknown>;
    expect(none.extras).toBeNull();
    expect("extras" in none).toBe(true);
    const off = (await (
      await handlePublicVisuals(req(), {
        settings: { PROFILE_PUB_ENABLED: false, PROFILE_PUB_BIO: "hello" },
      })
    ).json()) as Record<string, unknown>;
    expect(off.extras).toBeNull();
    const empty = (await (
      await handlePublicVisuals(req(), { settings: { PROFILE_IMAGE_URL: "https://img.test/a.png" } })
    ).json()) as Record<string, unknown>;
    expect(empty.extras).toBeNull();
    expect(empty.avatar).toBe("https://img.test/a.png");
  });

  it("rejects other methods", async () => {
    expect((await handlePublicVisuals(req("POST"), null)).status).toBe(405);
  });

  it("never re-serves an oversize or ill-typed stored value", async () => {
    const res = await handlePublicVisuals(req(), {
      settings: {
        PROFILE_IMAGE_URL: "https://x/" + "a".repeat(5 * 1024 * 1024),
        PROFILE_BANNER_URL: "https://x/" + "b".repeat(2048 - 10),
        PROFILE_BACKGROUND_URL: "https://x/" + "c".repeat(2048 - 9),
        PROFILE_BANNER_MODE: "m".repeat(65),
        PROFILE_AVATAR_BG: 12,
        PROFILE_BANNER_COLOR: "#123456",
        PROFILE_AVATAR_POSITION_X: "NaN",
        PROFILE_AVATAR_SCALE: "120",
        LOGTIME_EMOJI: "e".repeat(65),
        LOGTIME_LABELS_COLOR: "#abcdef",
        LOGTIME_EMOJI_RATE: "3",
        LOGTIME_EMOJI_DIVISOR: 4,
      },
    });
    const text = await res.text();
    expect(text.length).toBeLessThan(8 * 1024);
    const body = JSON.parse(text) as Record<string, any>;
    expect(body.avatar).toBe("");
    // 2048 characters pass, 2049 do not
    expect(body.banner).toHaveLength(2048);
    expect(body.background).toBe("");
    expect(body.bannerMode).toBe("fill");
    expect(body.avatarBg).toBe("transparent");
    expect(body.bannerColor).toBe("#123456");
    expect(body.avatarPosX).toBe(50);
    expect(body.avatarScale).toBe(120);
    expect(body.logtime.emoji).toBeUndefined();
    expect(body.logtime.labelsColor).toBe("#abcdef");
    expect(body.logtime.emojiRate).toBeUndefined();
    expect(body.logtime.emojiDivisor).toBe(4);
  });

  it("lets the browser cache the answer for five minutes", async () => {
    const res = await handlePublicVisuals(req(), null);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
