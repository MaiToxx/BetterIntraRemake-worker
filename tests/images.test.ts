import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { handlePrivateSettings } from "../src/handlers/settings";
import { orientationSegment, stripImageMetadata } from "../src/image-strip";
import type { Env, UserData } from "../src/types";
import { FakeD1, FakeKV, FakeRateLimit, budgetCount, kvRateLimitError, makeEnv } from "./helpers/fake-env";
import { KV_RETRY } from "../src/utils";
import { containsText, readFixture } from "./helpers/fixtures";
import { LIMITS, resetRateLimits } from "../src/rate-limit";

const LOGIN = "a".repeat(64);
const SESSION = "session-img";
const PNG = readFixture("gps.png");
const JPEG = readFixture("gps.jpg");

let env: Env;
let kv: FakeKV;
/** The upload's `v` is Date.now(): a frozen clock that tick() moves. */
let clock = 1_800_000_000_000;
beforeEach(() => {
  vi.spyOn(Date, "now").mockImplementation(() => clock);
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

const remove = (opts: { slot?: string; session?: string } = {}) =>
  worker.fetch(
    new Request(
      `https://w.test/api/v1/private/images?login=${LOGIN}&slot=${opts.slot ?? "avatar"}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${opts.session ?? SESSION}` } },
    ),
    env,
  );

const get = (url: string) => worker.fetch(new Request(url), env);

async function uploadedUrl(body: Uint8Array, slot = "avatar"): Promise<string> {
  const res = await upload(body, { slot });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const tick = () => {
  clock += 1_000;
};

describe("image upload", () => {
  it("stores a PNG under the user's slot and answers its URL", async () => {
    const url = await uploadedUrl(PNG);
    expect(url).toMatch(new RegExp(`^https://w.test/img/${LOGIN}/avatar\\?v=\\d+$`));
    expect(kv.puts).toEqual([`img:${LOGIN}:avatar`]);

    const served = await get(url);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(served.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(stripImageMetadata(PNG, "image/png"));
  });

  it("serves a GPS-tagged photo without its location, device, date or XMP, orientation kept", async () => {
    for (const leak of ["TestPhone", "Mulhouse", "taken at home", "xmpmeta"]) {
      expect(containsText(JPEG, leak)).toBe(true);
    }
    const served = new Uint8Array(await (await get(await uploadedUrl(JPEG, "banner"))).arrayBuffer());
    for (const leak of ["TestPhone", "Mulhouse", "taken at home", "xmpmeta", "MPF"]) {
      expect(containsText(served, leak)).toBe(false);
    }
    expect(containsText(served, String.fromCharCode(...orientationSegment(6)))).toBe(true);
    expect(served.length).toBeLessThan(JPEG.length);
  });

  it("types the image from its bytes, whatever the client says", async () => {
    const served = await get(await uploadedUrl(JPEG, "banner"));
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("refuses what is not an image, an unknown slot, and a bad session", async () => {
    expect((await upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(415);
    expect((await upload(PNG, { slot: "cv" })).status).toBe(400);
    expect((await upload(PNG, { session: "forged" })).status).toBe(401);
    expect((await upload(PNG, { login: "b".repeat(64) })).status).toBe(401);
    expect(kv.puts).toEqual([]);
  });

  it("refuses an image it cannot clean rather than storing it raw", async () => {
    // JPEG magic bytes, then an Exif segment whose length runs past the end
    const broken = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, ...new TextEncoder().encode("Exif GPS"),
    ]);
    const res = await upload(broken);
    expect(res.status).toBe(415);
    expect(await res.text()).toMatch(/could not read/i);
    expect(kv.puts).toEqual([]);
  });

  it("caps the body at 2 MB", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(big)).status).toBe(413);
    expect(kv.puts).toEqual([]);
  });

  it("replaces the previous image in place: one key, a new version", async () => {
    const first = await uploadedUrl(PNG);
    tick();
    const second = await uploadedUrl(JPEG);
    expect(second).not.toBe(first);
    expect(kv.puts).toEqual([`img:${LOGIN}:avatar`, `img:${LOGIN}:avatar`]);
    const served = await get(second);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("answers 404 for a missing image and refuses a POST on the public path", async () => {
    expect((await get(`https://w.test/img/${LOGIN}/avatar`)).status).toBe(404);
    expect((await get(`https://w.test/img/${LOGIN}/avatar?v=1`)).status).toBe(404);
    expect((await get(`https://w.test/img/${LOGIN}/x`)).status).toBe(404);
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
    expect((await get(`https://w.test/img/${LOGIN}/avatar`)).status).toBe(404);
  });
});

describe("image versions: a URL only ever caches the bytes it names", () => {
  it("redirects a superseded version to the current one, uncached, readable cross-origin", async () => {
    const first = await uploadedUrl(PNG);
    tick();
    const second = await uploadedUrl(JPEG);

    const old = await get(first);
    expect(old.status).toBe(302);
    expect(old.headers.get("Location")).toBe(second);
    expect(old.headers.get("Cache-Control")).toBe("no-store");
    expect(old.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(old.headers.get("Content-Type")).toBeNull();

    const current = await get(second);
    expect(current.status).toBe(200);
    expect(current.headers.get("Cache-Control")).toContain("immutable");
  });

  it("redirects a URL without a version, or with one never uploaded, instead of serving it for a year", async () => {
    const url = await uploadedUrl(PNG);
    for (const other of [
      `https://w.test/img/${LOGIN}/avatar`,
      `https://w.test/img/${LOGIN}/avatar?v=99999999999999`,
      `https://w.test/img/${LOGIN}/avatar?v=`,
    ]) {
      const res = await get(other);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe(url);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("serves an image stored without a version, but never as immutable", async () => {
    kv.data.set(`img:${LOGIN}:avatar`, stripImageMetadata(PNG, "image/png")!.slice().buffer);
    kv.meta.set(`img:${LOGIN}:avatar`, { type: "image/png" });
    const res = await get(`https://w.test/img/${LOGIN}/avatar?v=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });
});

describe("image delete", () => {
  it("removes that slot only, and the public URL stops serving it", async () => {
    const avatar = await uploadedUrl(PNG);
    const banner = await uploadedUrl(JPEG, "banner");
    const res = await remove();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(kv.deletes).toEqual([`img:${LOGIN}:avatar`]);
    expect((await get(avatar)).status).toBe(404);
    expect((await get(banner)).status).toBe(200);
  });

  it("answers 204 when there was nothing to delete", async () => {
    expect((await remove({ slot: "background" })).status).toBe(204);
  });

  it("needs the session and a known slot, and deletes nothing otherwise", async () => {
    await uploadedUrl(PNG);
    expect((await remove({ session: "forged" })).status).toBe(401);
    expect((await remove({ slot: "cv" })).status).toBe(400);
    const anonymous = await worker.fetch(
      new Request(`https://w.test/api/v1/private/images?login=${LOGIN}&slot=avatar`, {
        method: "DELETE",
      }),
      env,
    );
    expect(anonymous.status).toBe(401);
    expect(kv.deletes).toEqual([]);
  });

  it("counts against the write limit like an upload", async () => {
    for (let i = 0; i < LIMITS.write.limit; i++) expect((await remove()).status).toBe(204);
    const res = await remove();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(kv.deletes).toHaveLength(LIMITS.write.limit);
  });

  it("uses the write binding when bound", async () => {
    const write = new FakeRateLimit();
    write.denyAll = true;
    ({ env, kv } = makeEnv({
      kv: new FakeKV({ [LOGIN]: { sessionTokens: [SESSION], settings: {} } }),
      vars: { WRITE_RL: write },
    }));
    expect((await remove()).status).toBe(429);
    expect(write.calls).toEqual([LOGIN]);
    expect(kv.deletes).toEqual([]);
  });

  it("refuses other methods on the private route", async () => {
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/images?login=${LOGIN}&slot=avatar`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${SESSION}` },
      }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("image upload: daily budget and KV busy", () => {
  beforeEach(() => {
    KV_RETRY.delayMs = 0;
  });
  afterEach(() => {
    KV_RETRY.delayMs = 1100;
  });

  it("spends one unit of the day's KV writes per stored upload, none per delete", async () => {
    const d1 = env.better_intra_d1 as unknown as FakeD1;
    await uploadedUrl(PNG);
    expect(budgetCount(d1, LOGIN)).toBe(1);
    expect((await remove()).status).toBe(204);
    expect(budgetCount(d1, LOGIN)).toBe(1);
  });

  it("retries a write KV refused for the per-key limit, with the version of the write that stored it", async () => {
    kv.putErrors.push(kvRateLimitError());
    const res = await upload(PNG);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(kv.putAttempts).toBe(2);
    expect((await get(url)).status).toBe(200);
  });

  it("answers 503 kv_busy when the retry is refused too, and stores nothing", async () => {
    kv.putErrors.push(kvRateLimitError(), kvRateLimitError());
    const res = await upload(PNG);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { error: string }).error).toBe("kv_busy");
    expect(kv.data.has(`img:${LOGIN}:avatar`)).toBe(false);
  });

  it("names both unreadable cases with one code", async () => {
    const notImage = await upload(new TextEncoder().encode("hello"));
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: string }).error).toBe("unsupported_image_type");
    // a PNG signature on a body that does not parse
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await upload(broken);
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: "unsupported_image_type",
      message: "Could not read this image: save it again, or use another one",
    });
  });
});
