import { Env, UserData } from "../types";
import { rateLimited, tooManyRes } from "../rate-limit";
import { corsHeaders, jsonRes, readBodyCapped, requireSession, textRes } from "../utils";
import { sniffImageType, stripImageMetadata } from "../image-strip";

export { sniffImageType };

/**
 * Profile images uploaded from the editor, kept in KV: one value per user
 * and slot (`img:<login hash>:<slot>`), so a student owns at most three and
 * a new upload replaces the old one (one KV write, none of the daily budget
 * wasted on history). This edition has no R2 bucket; KV values go up to
 * 25 MB and the cap here is far below that.
 *
 * Served at GET /img/<hash>/<slot>?v=<n>. The `v` the upload answers changes
 * on every upload and names one set of bytes: only the URL whose `v` matches
 * the stored image gets the year of immutable cache. Any other `v` (a
 * superseded upload saved in a profile or a URL history, or a location whose
 * KV copy still holds the previous upload) is redirected, uncached, to the
 * current one, so a URL is never cached with bytes it does not name, and a
 * saved profile never shows a broken image because it was replaced.
 */
export const IMAGE_SLOTS = ["avatar", "banner", "background"] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const KEY_PREFIX = "img:";

export const imageKey = (loginHash: string, slot: ImageSlot): string =>
  `${KEY_PREFIX}${loginHash}:${slot}`;

export interface ImageMeta {
  type: string;
  /** Changes on every upload: the cache-busting `v` of the served URL. */
  v: number;
}

export function isImageSlot(value: string | null): value is ImageSlot {
  return (IMAGE_SLOTS as readonly string[]).includes(value ?? "");
}

export const imagePath = (loginHash: string, slot: ImageSlot, v: number): string =>
  `/img/${loginHash}/${slot}?v=${v}`;

/**
 * /api/v1/private/images?login=<hash>&slot=<slot>
 *  - POST, body: the raw image. Stored without its metadata (location, date,
 *    device: see src/image-strip.ts); answers {url}.
 *  - DELETE: removes that slot's image (204, also when there was none).
 */
export async function handleImageUpload(
  request: Request,
  env: Env,
  loginParam: string,
  existingData: UserData | null,
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return textRes("Method not allowed", 405);
  }
  const denied = requireSession(request, existingData);
  if (denied) return denied;

  const slot = new URL(request.url).searchParams.get("slot");
  if (!isImageSlot(slot)) return textRes("Unknown image slot", 400);
  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  if (request.method === "DELETE") {
    // One delete, no existence check: a read would buffer up to 2 MB to save
    // an operation the extension only spends when it knows there is an image.
    await env.BETTER_INTRA_KV.delete(imageKey(loginParam, slot));
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const bytes = await readBodyCapped(request, MAX_IMAGE_BYTES);
  if (bytes === null) return textRes("Image too large (2 MB at most)", 413);
  const type = sniffImageType(bytes);
  if (!type) return textRes("Not a PNG, JPEG, GIF or WebP image", 415);
  // Never the raw bytes: a file that cannot be cleaned is not stored.
  const clean = stripImageMetadata(bytes, type);
  if (!clean) return textRes("Could not read this image: save it again, or use another one", 415);

  const v = Date.now();
  await env.BETTER_INTRA_KV.put(imageKey(loginParam, slot), clean, {
    metadata: { type, v } satisfies ImageMeta,
  });
  const origin = new URL(request.url).origin;
  return jsonRes({ url: `${origin}${imagePath(loginParam, slot, v)}` });
}

/**
 * GET /img/<hash>/<slot>?v=<n>: the stored image, public. Cached for a year
 * only under the `v` it was uploaded with; see the top of this file.
 */
export async function handleImageServe(
  env: Env,
  loginHash: string,
  slot: string,
  v: string | null,
  origin: string,
): Promise<Response> {
  if (!isImageSlot(slot)) return textRes("Not found", 404);
  const { value, metadata } = await env.BETTER_INTRA_KV.getWithMetadata<ImageMeta>(
    imageKey(loginHash, slot),
    { type: "arrayBuffer" },
  );
  if (!value || !metadata?.type) return textRes("Not found", 404);
  const current = typeof metadata.v === "number" ? metadata.v : null;
  if (current !== null && v !== String(current)) {
    return new Response(null, {
      status: 302,
      headers: {
        ...corsHeaders,
        Location: `${origin}${imagePath(loginHash, slot, current)}`,
        // The target changes with the next upload: a cached redirect would
        // pin this URL to an image it does not name.
        "Cache-Control": "no-store",
      },
    });
  }
  return new Response(value, {
    headers: {
      ...corsHeaders,
      "Content-Type": metadata.type,
      // Without a stored version there is nothing to pin the bytes to.
      "Cache-Control":
        current === null ? "no-cache" : "public, max-age=31536000, immutable",
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
