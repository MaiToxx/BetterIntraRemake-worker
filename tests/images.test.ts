import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import { handlePrivateSettings } from "../src/handlers/settings";
import type { Env, UserData } from "../src/types";
import { FakeKV, makeEnv } from "./helpers/fake-env";
import { resetRateLimits } from "../src/rate-limit";

const LOGIN = "a".repeat(64);
const SESSION = "session-img";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

let env: Env;
let kv: FakeKV;
beforeEach(() => {
  resetRateLimits();
  const record: UserData = { sessionTokens: [SESSION], settings: {} };
  ({ env, kv } = makeEnv({ kv: new FakeKV({ [LOGIN]: record }) }));
});

const upload = (
  body: BodyInit | null,
  opts: { slot?: string; session?: string; login?: string } = {},
) =>
  worker.fetch(
    new Request(
      `https://w.test/api/v1/private/images?login=${opts.login ?? LOGIN}&slot=${opts.slot ?? "avatar"}`,
      { method: "POST", body, headers: { Authorization: `Bearer ${opts.session ?? SESSION}` } },
    ),
    env,
  );

describe("image upload", () => {
  it("stores a PNG under the user's slot and answers its URL", async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^https://w.test/img/${LOGIN}/avatar\\?v=\\d+$`));
    expect(kv.puts).toEqual([`img:${LOGIN}:avatar`]);

    const served = await worker.fetch(new Request(url), env);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.get("Cache-Control")).toContain("max-age=31536000");
    expect(served.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("types the image from its bytes, whatever the client says", async () => {
    const res = await upload(JPEG, { slot: "banner" });
    const { url } = (await res.json()) as { url: string };
    const served = await worker.fetch(new Request(url), env);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("refuses what is not an image, an unknown slot, and a bad session", async () => {
    expect((await upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(415);
    expect((await upload(PNG, { slot: "cv" })).status).toBe(400);
    expect((await upload(PNG, { session: "forged" })).status).toBe(401);
    expect((await upload(PNG, { login: "b".repeat(64) })).status).toBe(401);
    expect(kv.puts).toEqual([]);
  });

  it("caps the body at 2 MB", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(big)).status).toBe(413);
    expect(kv.puts).toEqual([]);
  });

  it("replaces the previous image in place: one key, a new version", async () => {
    const first = (await (await upload(PNG)).json()) as { url: string };
    await new Promise((r) => setTimeout(r, 2));
    const second = (await (await upload(JPEG)).json()) as { url: string };
    expect(second.url).not.toBe(first.url);
    expect(kv.puts).toEqual([`img:${LOGIN}:avatar`, `img:${LOGIN}:avatar`]);
    const served = await worker.fetch(new Request(second.url), env);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("answers 404 for a missing image and refuses a POST on the public path", async () => {
    expect((await worker.fetch(new Request(`https://w.test/img/${LOGIN}/avatar`), env)).status).toBe(404);
    expect((await worker.fetch(new Request(`https://w.test/img/${LOGIN}/x`), env)).status).toBe(404);
    expect(
      (await worker.fetch(new Request(`https://w.test/img/${LOGIN}/avatar`, { method: "POST" }), env))
        .status,
    ).toBe(405);
  });

  it("Wipe all data deletes the images", async () => {
    await upload(PNG);
    await upload(PNG, { slot: "background" });
    const req = new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}&all=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SESSION}` },
    });
    const record = (await kv.get(LOGIN, "json")) as UserData;
    expect((await handlePrivateSettings(req, env, LOGIN, record)).status).toBe(200);
    expect(kv.deletes).toEqual(
      expect.arrayContaining([`img:${LOGIN}:avatar`, `img:${LOGIN}:banner`, `img:${LOGIN}:background`]),
    );
    expect((await worker.fetch(new Request(`https://w.test/img/${LOGIN}/avatar`), env)).status).toBe(404);
  });
});
