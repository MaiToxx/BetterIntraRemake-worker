import { Env, UserData } from "../types";
import { rateLimited, tooManyRes } from "../rate-limit";
import { corsHeaders, jsonRes, readBodyCapped, requireSession, textRes } from "../utils";

/**
 * Profile images uploaded from the editor, kept in KV: one value per user
 * and slot (`img:<login hash>:<slot>`), so a student owns at most three and
 * a new upload replaces the old one (one KV write, none of the daily budget
 * wasted on history). This edition has no R2 bucket; KV values go up to
 * 25 MB and the cap here is far below that.
 *
 * Served at GET /img/<hash>/<slot>?v=<n> with a year of cache: the `v` the
 * upload answers changes on every upload, so a replaced image shows at once
 * while the old URL stays cacheable.
 */
export const IMAGE_SLOTS = ["avatar", "banner", "background"] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const KEY_PREFIX = "img:";

export const imageKey = (loginHash: string, slot: ImageSlot): string =>
  `${KEY_PREFIX}${loginHash}:${slot}`;

/**
 * The image type from the bytes, never from the client's Content-Type: what
 * is served back under image/* must really be an image the browser will
 * only ever draw.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  )
    return "image/webp";
  return null;
}

interface ImageMeta {
  type: string;
  /** Changes on every upload: the cache-busting `v` of the served URL. */
  v: number;
}

export function isImageSlot(value: string | null): value is ImageSlot {
  return (IMAGE_SLOTS as readonly string[]).includes(value ?? "");
}

/** POST /api/v1/private/images?login=<hash>&slot=<slot>, body: the raw image. */
export async function handleImageUpload(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST") return textRes("Method not allowed", 405);
  const denied = requireSession(request, existingData);
  if (denied) return denied;

  const slot = new URL(request.url).searchParams.get("slot");
  if (!isImageSlot(slot)) return textRes("Unknown image slot", 400);
  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  const bytes = await readBodyCapped(request, MAX_IMAGE_BYTES);
  if (bytes === null) return textRes("Image too large (2 MB at most)", 413);
  const type = sniffImageType(bytes);
  if (!type) return textRes("Not a PNG, JPEG, GIF or WebP image", 415);

  const v = Date.now();
  await env.BETTER_INTRA_KV.put(imageKey(loginParam, slot), bytes, {
    metadata: { type, v } satisfies ImageMeta,
  });
  const origin = new URL(request.url).origin;
  return jsonRes({ url: `${origin}/img/${loginParam}/${slot}?v=${v}` });
}

/** GET /img/<hash>/<slot>: the stored image, public, cached for a year. */
export async function handleImageServe(
  env: Env,
  loginHash: string,
  slot: string,
): Promise<Response> {
  if (!isImageSlot(slot)) return textRes("Not found", 404);
  const { value, metadata } = await env.BETTER_INTRA_KV.getWithMetadata<ImageMeta>(
    imageKey(loginHash, slot),
    { type: "arrayBuffer" },
  );
  if (!value || !metadata?.type) return textRes("Not found", 404);
  return new Response(value, {
    headers: {
      ...corsHeaders,
      "Content-Type": metadata.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      // An image is only ever drawn; never a document on this origin.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}

/** Wipe all data: the three images go with the record. Best effort. */
export async function deleteUserImages(env: Env, loginHash: string): Promise<void> {
  for (const slot of IMAGE_SLOTS) {
    try {
      await env.BETTER_INTRA_KV.delete(imageKey(loginHash, slot));
    } catch (e) {
      console.warn(`[images] delete failed: ${e}`);
    }
  }
}
