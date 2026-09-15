import { describe, it, expect } from "vitest";
import { handlePublicVisuals, publicLook } from "../src/handlers/settings";

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

  it("rejects other methods", async () => {
    expect((await handlePublicVisuals(req("POST"), null)).status).toBe(405);
  });
});
