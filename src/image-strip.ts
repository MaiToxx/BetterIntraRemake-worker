/**
 * Metadata removal for uploaded profile images, on the bytes only (no pixel
 * is decoded or re-encoded, so quality, animation and colour profiles stay
 * exactly as uploaded).
 *
 * Why: an uploaded image is public at /img/sha256(login)/<slot>, a URL
 * anyone who knows a login can compute, and a phone photo carries where it
 * was taken (GPS), when, and on which device. Image hosts students used
 * before uploads existed strip that; this worker must too.
 *
 * What goes, per format:
 *  - JPEG: every APPn segment except APP0 (JFIF), APP2 ICC_PROFILE and APP14
 *    Adobe (needed to decode CMYK/YCCK colours), every COM segment, and
 *    everything after the first image's EOI (MPO second frames, gain maps,
 *    motion-photo videos, vendor trailers). An Exif Orientation other than 1
 *    is written back as a 34-byte Exif block holding that tag alone, because
 *    browsers rotate phone photos by it.
 *  - PNG: eXIf, tEXt, zTXt, iTXt, tIME and caBX (C2PA) chunks, and anything
 *    after IEND. Chunk CRCs cover single chunks, so the others stay valid.
 *  - WebP: EXIF and XMP chunks, their VP8X flags, anything after the RIFF
 *    payload; the RIFF size is rewritten.
 *  - GIF: comment extensions and every application extension except the
 *    loop (NETSCAPE2.0, ANIMEXTS1.0) and ICC (ICCRGBG1012) ones, so XMP goes;
 *    anything after the trailer.
 *
 * A file whose structure does not parse gives null: the caller refuses it
 * rather than storing bytes it could not clean.
 *
 * No imports and erasable TypeScript only, so that
 * scripts/strip-image-metadata.mjs can load this file with plain Node.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * The image type from the bytes, never from the client's Content-Type: what
 * is served back under image/* must really be an image the browser will
 * only ever draw.
 */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
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

/** `bytes` without its metadata, or null when it does not parse as `type`. */
export function stripImageMetadata(bytes: Uint8Array, type: string): Uint8Array | null {
  switch (type) {
    case "image/jpeg":
      return stripJpeg(bytes);
    case "image/png":
      return stripPng(bytes);
    case "image/webp":
      return stripWebp(bytes);
    case "image/gif":
      return stripGif(bytes);
    default:
      return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function ascii(b: Uint8Array, start: number, length: number): string {
  let s = "";
  for (let i = start; i < start + length && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function startsWith(b: Uint8Array, text: string): boolean {
  return ascii(b, 0, text.length) === text;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

const JPEG_EOI = new Uint8Array([0xff, 0xd9]);

/** APPn and COM segments that stay: the rest of the APPn range is metadata. */
function keepJpegSegment(marker: number, data: Uint8Array): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker < 0xe0 || marker > 0xef) return true; // not APPn: image data
  if (marker === 0xe0) return true; // APP0 JFIF / JFXX
  if (marker === 0xe2) return startsWith(data, "ICC_PROFILE\0");
  if (marker === 0xee) return startsWith(data, "Adobe");
  return false;
}

/** Exif Orientation (1-8) of an APP1 payload, 1 when absent or unreadable. */
export function exifOrientation(data: Uint8Array): number {
  if (!startsWith(data, "Exif\0\0")) return 1;
  const tiff = data.subarray(6);
  if (tiff.length < 8) return 1;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const u16 = (i: number) => (little ? tiff[i] | (tiff[i + 1] << 8) : (tiff[i] << 8) | tiff[i + 1]);
  const u32 = (i: number) =>
    (little
      ? tiff[i] | (tiff[i + 1] << 8) | (tiff[i + 2] << 16) | (tiff[i + 3] << 24)
      : (tiff[i] << 24) | (tiff[i + 1] << 16) | (tiff[i + 2] << 8) | tiff[i + 3]) >>> 0;
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) !== 0x0112) continue;
    if (u16(entry + 2) !== 3) return 1; // SHORT, per the Exif spec
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** APP1 segment carrying a single Exif tag, Orientation (big-endian TIFF). */
export function orientationSegment(orientation: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, // APP1, length 34 (itself included)
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  let scanned = false;
  let orientationKept = false;
  for (;;) {
    // Next marker, skipping stray bytes and 0xFF fill the way libjpeg does:
    // what sits between segments is never copied.
    const ff = b.indexOf(0xff, p);
    if (ff < 0) break;
    p = ff;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) break;
    const marker = b[p++];
    if (marker === 0x00) continue; // stuffed zero outside a scan: stray data
    if (marker === 0xd9) {
      out.push(JPEG_EOI); // anything after the first image's EOI goes
      return concat(out);
    }
    if (marker === 0xd8) return null; // a second SOI before EOI
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(new Uint8Array([0xff, marker])); // RSTn, TEM: no length
      continue;
    }
    const length = p + 2 <= b.length ? (b[p] << 8) | b[p + 1] : 0;
    if (length < 2 || p + length > b.length) {
      // cut short inside a segment: like a missing EOI once image data was read
      if (!scanned) return null;
      break;
    }
    const segment = b.subarray(p - 2, p + length);
    const data = b.subarray(p + 2, p + length);
    p += length;

    if (marker === 0xda) {
      // SOS header, then entropy-coded data up to the next real marker
      // (0xFF00 is a stuffed byte, 0xFFD0-D7 a restart, 0xFFFF fill).
      out.push(segment);
      const start = p;
      for (;;) {
        const next = b.indexOf(0xff, p);
        if (next < 0 || next + 1 >= b.length) {
          p = b.length;
          break;
        }
        const n = b[next + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
          p = next + (n === 0xff ? 1 : 2);
          continue;
        }
        p = next;
        break;
      }
      out.push(b.subarray(start, p));
      scanned = true;
      continue;
    }

    if (keepJpegSegment(marker, data)) {
      out.push(segment);
    } else if (marker === 0xe1 && !orientationKept) {
      const orientation = exifOrientation(data);
      if (orientation !== 1) {
        out.push(orientationSegment(orientation));
        orientationKept = true;
      }
    }
  }
  // No EOI: a truncated file the browser still draws in part. Keep what was
  // read when there was image data at all.
  if (!scanned) return null;
  out.push(JPEG_EOI);
  return concat(out);
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "caBX"]);
const PNG_IEND = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let p = 8;
  let sawData = false;
  while (p < b.length) {
    const end =
      p + 12 <= b.length
        ? p + 12 + (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0)
        : Infinity;
    if (end > b.length) break; // cut short: handled below
    const type = ascii(b, p + 4, 4);
    if (p === 8 && type !== "IHDR") return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(p, end));
    if (type === "IDAT") sawData = true;
    p = end;
    if (type === "IEND") return concat(out);
  }
  // No IEND (truncated, or a chunk running past the end): the image data
  // already read is what a browser would draw.
  if (!sawData) return null;
  out.push(PNG_IEND);
  return concat(out);
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 20 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const declared = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
  const riffEnd = Math.min(8 + declared, b.length);
  const out: Uint8Array[] = [];
  let p = 12;
  while (p + 8 <= riffEnd) {
    const fourcc = ascii(b, p, 4);
    const size = (b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)) >>> 0;
    if (p + 8 + size > riffEnd) return null;
    if (p === 12 && fourcc !== "VP8 " && fourcc !== "VP8L" && fourcc !== "VP8X") return null;
    const padded = p + 8 + size + (size & 1);
    const end = Math.min(padded, riffEnd);
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      p = end;
      continue;
    }
    if (fourcc === "VP8X" && size >= 1) {
      const chunk = b.slice(p, end);
      chunk[8] &= ~(VP8X_EXIF | VP8X_XMP);
      out.push(chunk);
    } else {
      out.push(b.subarray(p, end));
    }
    // an odd-sized last chunk written without its pad byte gets one
    if (end < padded) out.push(new Uint8Array(1));
    p = padded;
  }
  if (out.length === 0) return null;
  const body = concat(out);
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  const riffSize = body.byteLength + 4;
  header[4] = riffSize & 0xff;
  header[5] = (riffSize >>> 8) & 0xff;
  header[6] = (riffSize >>> 16) & 0xff;
  header[7] = (riffSize >>> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return concat([header, body]);
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

const GIF_TRAILER = new Uint8Array([0x3b]);
const GIF_KEPT_APPLICATIONS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

/** Index after the sub-block chain starting at `q` (its 0 terminator included), or -1. */
function skipSubBlocks(b: Uint8Array, q: number): number {
  while (q < b.length) {
    const size = b[q];
    q += 1 + size;
    if (size === 0) return q;
  }
  return -1;
}

function stripGif(b: Uint8Array): Uint8Array | null {
  if (b.length < 13 || ascii(b, 0, 3) !== "GIF") return null;
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1)); // global colour table
  if (p > b.length) return null;
  const out: Uint8Array[] = [b.subarray(0, p)];
  let sawImage = false;
  while (p < b.length) {
    const introducer = b[p];
    if (introducer === 0x3b) {
      out.push(GIF_TRAILER); // anything after the trailer goes
      return concat(out);
    }
    if (introducer === 0x21) {
      if (p + 2 > b.length) return null;
      const label = b[p + 1];
      const end = skipSubBlocks(b, p + 2);
      if (end < 0) return null;
      let keep = label !== 0xfe; // comment extension
      if (label === 0xff) {
        keep = b[p + 2] === 11 && GIF_KEPT_APPLICATIONS.has(ascii(b, p + 3, 11));
      }
      if (keep) out.push(b.subarray(p, end));
      p = end;
      continue;
    }
    if (introducer === 0x2c) {
      if (p + 10 > b.length) return null;
      let q = p + 10;
      if (b[p + 9] & 0x80) q += 3 * (1 << ((b[p + 9] & 0x07) + 1)); // local colour table
      q += 1; // LZW minimum code size
      if (q > b.length) return null;
      const end = skipSubBlocks(b, q);
      if (end < 0) return null;
      out.push(b.subarray(p, end));
      sawImage = true;
      p = end;
      continue;
    }
    // An unknown block: decoders stop here too.
    break;
  }
  if (!sawImage) return null;
  out.push(GIF_TRAILER);
  return concat(out);
}
