import { describe, it, expect } from "vitest";
import { restripImages, type ImageKv } from "../scripts/strip-image-metadata.mjs";
import { stripImageMetadata } from "../src/image-strip";
import { containsText, readFixture } from "./helpers/fixtures";

const HASH = "a".repeat(64);

/** In-memory namespace with the calls the script makes, writes counted. */
function fakeKv(seed: Record<string, { bytes: Uint8Array; metadata?: unknown }>) {
  const data = new Map(Object.entries(seed));
  const puts: string[] = [];
  const kv: ImageKv = {
    list: async (prefix) =>
      [...data.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, v]) => ({ name, metadata: v.metadata })),
    get: async (key) => data.get(key)?.bytes ?? null,
    put: async (key, bytes, metadata) => {
      puts.push(key);
      data.set(key, { bytes, metadata });
    },
  };
  return { kv, data, puts };
}

const JPEG = readFixture("gps.jpg");
const PNG = readFixture("gps.png");

describe("scripts/strip-image-metadata.mjs", () => {
  it("rewrites a GPS-tagged image with its metadata {type, v} unchanged, so its URL keeps serving", async () => {
    const meta = { type: "image/jpeg", v: 1_790_000_000_000 };
    const { kv, data, puts } = fakeKv({
      [`img:${HASH}:avatar`]: { bytes: JPEG, metadata: meta },
      [HASH]: { bytes: new TextEncoder().encode("{}") }, // a user record: not touched
    });
    const result = await restripImages(kv, { apply: true });
    expect(result.cleaned).toEqual([`img:${HASH}:avatar`]);
    expect(puts).toEqual([`img:${HASH}:avatar`]);
    const stored = data.get(`img:${HASH}:avatar`)!;
    expect(stored.metadata).toEqual(meta);
    expect(stored.bytes).toEqual(stripImageMetadata(JPEG, "image/jpeg"));
    expect(containsText(stored.bytes, "TestPhone")).toBe(false);
  });

  it("writes nothing in a dry run, nor for an image already clean", async () => {
    const clean = stripImageMetadata(PNG, "image/png")!;
    const { kv, puts } = fakeKv({
      [`img:${HASH}:avatar`]: { bytes: JPEG, metadata: { type: "image/jpeg", v: 1 } },
      [`img:${HASH}:banner`]: { bytes: clean, metadata: { type: "image/png", v: 2 } },
    });
    const dry = await restripImages(kv);
    expect(dry.cleaned).toEqual([`img:${HASH}:avatar`]);
    expect(dry.alreadyClean).toEqual([`img:${HASH}:banner`]);
    expect(puts).toEqual([]);

    await restripImages(kv, { apply: true });
    const again = await restripImages(kv, { apply: true });
    expect(again.cleaned).toEqual([]);
    expect(puts).toEqual([`img:${HASH}:avatar`]);
  });

  it("leaves alone what it cannot clean or could not serve again", async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 1, 2, 3]);
    const { kv, puts } = fakeKv({
      [`img:${HASH}:avatar`]: { bytes: broken, metadata: { type: "image/jpeg", v: 1 } },
      [`img:${HASH}:banner`]: { bytes: JPEG }, // no metadata
      [`img:${HASH}:background`]: { bytes: JPEG, metadata: { type: "image/png", v: 3 } },
    });
    const lines: string[] = [];
    const result = await restripImages(kv, { apply: true, log: (l) => lines.push(l) });
    expect(result.skipped.sort()).toEqual(
      [`img:${HASH}:avatar`, `img:${HASH}:background`, `img:${HASH}:banner`].sort(),
    );
    expect(puts).toEqual([]);
    expect(lines).toHaveLength(3);
  });
});
