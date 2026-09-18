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
});
