import { describe, it, expect } from "vitest";
import {
  exifOrientation,
  orientationSegment,
  sniffImageType,
  stripImageMetadata,
} from "../src/image-strip";
import { containsText, readFixture } from "./helpers/fixtures";

/** What must never survive: device, place, date, free text, XMP. */
const LEAKS = ["TestPhone", "TestMake", "2026:09:23", "Mulhouse", "taken at home", "xmpmeta", "47.7508"];

function leaks(bytes: Uint8Array): string[] {
  return LEAKS.filter((t) => containsText(bytes, t));
}

function strip(bytes: Uint8Array): Uint8Array {
  const type = sniffImageType(bytes);
  const out = type && stripImageMetadata(bytes, type);
  if (!out) throw new Error("did not parse");
  return out;
}

/** JPEG header segments up to the first SOS: [marker, bytes including FF xx]. */
function jpegHeader(b: Uint8Array): { marker: number; bytes: Uint8Array }[] {
  const out: { marker: number; bytes: Uint8Array }[] = [];
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const length = (b[p + 2] << 8) | b[p + 3];
    out.push({ marker, bytes: b.subarray(p, p + 2 + length) });
    if (marker === 0xda) break;
    p += 2 + length;
  }
  return out;
}

const ascii = (b: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...b.subarray(start, start + length));

function pngChunks(b: Uint8Array): { type: string; bytes: Uint8Array }[] {
  const out: { type: string; bytes: Uint8Array }[] = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    out.push({ type: ascii(b, p + 4, 4), bytes: b.subarray(p, p + 12 + len) });
    p += 12 + len;
  }
  return out;
}

const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function webpChunks(b: Uint8Array): { fourcc: string; data: Uint8Array }[] {
  const out: { fourcc: string; data: Uint8Array }[] = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const size = le32(b, p + 4);
    out.push({ fourcc: ascii(b, p, 4), data: b.subarray(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}

/** GIF blocks after the header: "ext:<label>[:<app id>]", "image", "trailer". */
function gifBlocks(b: Uint8Array): string[] {
  const out: string[] = [];
  let p = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
  const skip = (q: number) => {
    while (b[q] !== 0) q += 1 + b[q];
    return q + 1;
  };
  while (p < b.length) {
    if (b[p] === 0x3b) {
      out.push("trailer");
      p++;
      continue;
    }
    if (b[p] === 0x21) {
      const label = b[p + 1];
      out.push(label === 0xff ? `ext:ff:${ascii(b, p + 3, 11)}` : `ext:${label.toString(16)}`);
      p = skip(p + 2);
      continue;
    }
    if (b[p] === 0x2c) {
      out.push("image");
      let q = p + 10;
      if (b[p + 9] & 0x80) q += 3 * (1 << ((b[p + 9] & 7) + 1));
      p = skip(q + 1);
      continue;
    }
    out.push(`junk@${p}`);
    break;
  }
  return out;
}

describe("JPEG", () => {
  const src = readFixture("gps.jpg");
  const out = strip(src);

  it("the fixture really carries GPS, device, date, text and XMP", () => {
    expect(leaks(src)).toEqual(LEAKS.filter((t) => t !== "47.7508"));
  });

  it("drops Exif, XMP, IPTC, COM and MPF, keeps JFIF and the ICC profile", () => {
    expect(leaks(out)).toEqual([]);
    const header = jpegHeader(out);
    const app = header.filter((s) => (s.marker >= 0xe0 && s.marker <= 0xef) || s.marker === 0xfe);
    expect(app.map((s) => s.marker)).toEqual([0xe0, 0xe1, 0xe2]);
    expect(ascii(app[0].bytes, 4, 5)).toBe("JFIF\0");
    expect(ascii(app[2].bytes, 4, 12)).toBe("ICC_PROFILE\0");
  });

  it("writes Orientation 6 back as a one-tag Exif block", () => {
    const app1 = jpegHeader(out).find((s) => s.marker === 0xe1)!;
    expect(app1.bytes).toEqual(orientationSegment(6));
    expect(app1.bytes.length).toBe(36);
    expect(exifOrientation(app1.bytes.subarray(4))).toBe(6);
  });

  it("keeps the image data byte for byte and cuts what follows the first EOI", () => {
    const sosAt = (b: Uint8Array) => jpegHeader(b).at(-1)!.bytes.byteOffset - b.byteOffset;
    const eoiAfter = (b: Uint8Array, from: number) => {
      for (let i = from; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xd9) return i;
      return -1;
    };
    const scanIn = src.subarray(sosAt(src), eoiAfter(src, sosAt(src)) + 2);
    // SOS, entropy data with its restart markers, EOI: identical, and last
    expect(out.subarray(sosAt(out))).toEqual(scanIn);
    // the second JPEG after the first EOI (MPO frame, motion photo...) is gone
    expect(eoiAfter(src, sosAt(src)) + 2).toBeLessThan(src.length);
    expect(containsText(out.subarray(sosAt(out)), "\xff\xd8")).toBe(false);
  });

  it("stays a JPEG and is stable when stripped again", () => {
    expect(sniffImageType(out)).toBe("image/jpeg");
    expect(strip(out)).toEqual(out);
  });

  it("writes no Exif block at all for Orientation 1, and keeps every progressive scan", () => {
    const prog = readFixture("gps-progressive.jpg");
    const clean = strip(prog);
    expect(leaks(prog)).toContain("TestPhone");
    expect(leaks(clean)).toEqual([]);
    expect(jpegHeader(clean).some((s) => s.marker === 0xe1)).toBe(false);
    const scans = (b: Uint8Array) => {
      let n = 0;
      for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xda) n++;
      return n;
    };
    expect(scans(clean)).toBe(scans(prog));
    expect(scans(clean)).toBeGreaterThan(1);
  });

  it("finishes a truncated file with EOI, refuses one with no image data", () => {
    const cut = src.subarray(0, src.length - 800);
    const clean = strip(cut);
    expect(leaks(clean)).toEqual([]);
    expect(clean.at(-1)).toBe(0xd9);

    // cut inside a segment that follows the image data (a DHT header)
    const cutInSegment = new Uint8Array([...strip(readFixture("gps-progressive.jpg")).subarray(0, -2), 0xff, 0xc4, 0x00]);
    const finished = strip(cutInSegment);
    expect(finished.at(-2)).toBe(0xff);
    expect(finished.at(-1)).toBe(0xd9);

    const headerOnly = src.subarray(0, 20); // SOI + part of APP0
    expect(stripImageMetadata(headerOnly, "image/jpeg")).toBeNull();
    // a segment length pointing past the end
    expect(stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]), "image/jpeg")).toBeNull();
  });
});

describe("exifOrientation", () => {
  it("reads little-endian Exif too, and ignores a value out of range", () => {
    const le = (value: number) =>
      new Uint8Array([
        0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0,
        1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, value, 0, 0, 0, 0, 0, 0, 0,
      ]);
    expect(exifOrientation(le(8))).toBe(8);
    expect(exifOrientation(le(9))).toBe(1);
    expect(exifOrientation(new Uint8Array([0x45, 0x78]))).toBe(1);
    expect(exifOrientation(new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0"))).toBe(1);
  });
});

describe("PNG", () => {
  const src = readFixture("gps.png");
  const out = strip(src);

  it("drops eXIf, tEXt, zTXt, iTXt, tIME and what follows IEND, keeps the rest as is", () => {
    expect(pngChunks(src).map((c) => c.type)).toEqual(
      expect.arrayContaining(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "iCCP"]),
    );
    expect(containsText(src, "GPS 47.7508N trailer")).toBe(true);
    expect(leaks(out)).toEqual([]);
    const kept = pngChunks(out);
    expect(kept.map((c) => c.type)).toEqual(["IHDR", "iCCP", "IDAT", "IEND"]);
    // copied untouched, CRC included
    const originals = pngChunks(src);
    for (const c of kept) {
      expect(originals.find((o) => o.type === c.type)!.bytes).toEqual(c.bytes);
    }
    expect(containsText(out, "trailer")).toBe(false);
    expect(sniffImageType(out)).toBe("image/png");
  });

  it("refuses a PNG whose first chunk is not IHDR, or with no image data", () => {
    const sig = src.subarray(0, 8);
    expect(stripImageMetadata(sig, "image/png")).toBeNull();
    const noIhdr = new Uint8Array([...sig, ...pngChunks(src)[1].bytes]);
    expect(stripImageMetadata(noIhdr, "image/png")).toBeNull();
  });
});

describe("WebP", () => {
  const src = readFixture("gps.webp");
  const out = strip(src);

  it("drops the EXIF and XMP chunks and their VP8X flags, keeps ICC", () => {
    expect(webpChunks(src).map((c) => c.fourcc)).toEqual(expect.arrayContaining(["EXIF", "XMP "]));
    expect(leaks(out)).toEqual([]);
    const chunks = webpChunks(out);
    expect(chunks.map((c) => c.fourcc)).not.toContain("EXIF");
    expect(chunks.map((c) => c.fourcc)).not.toContain("XMP ");
    const flagsIn = webpChunks(src)[0].data[0];
    const flagsOut = chunks[0].data[0];
    expect(chunks[0].fourcc).toBe("VP8X");
    expect(flagsIn & 0x0c).toBe(0x0c);
    expect(flagsOut & 0x0c).toBe(0);
    expect(flagsOut & 0x20).toBe(0x20); // ICC still announced
    expect(chunks.map((c) => c.fourcc)).toContain("ICCP");
  });

  it("rewrites the RIFF size and cuts what follows the RIFF payload", () => {
    expect(le32(out, 4)).toBe(out.length - 8);
    expect(containsText(src, "trailer")).toBe(true);
    expect(containsText(out, "trailer")).toBe(false);
    expect(sniffImageType(out)).toBe("image/webp");
    expect(strip(out)).toEqual(out);
  });

  it("refuses a chunk that runs past the end", () => {
    const broken = src.slice(0, 40);
    broken[16] = 0xff; // first chunk size far over the file
    expect(stripImageMetadata(broken, "image/webp")).toBeNull();
  });
});

describe("GIF", () => {
  const src = readFixture("gps.gif");
  const out = strip(src);

  it("drops the comment and XMP extensions, keeps the loop and both frames", () => {
    expect(gifBlocks(src)).toEqual(
      expect.arrayContaining(["ext:fe", "ext:ff:XMP DataXMP", "ext:ff:NETSCAPE2.0"]),
    );
    expect(leaks(out)).toEqual([]);
    const blocks = gifBlocks(out);
    expect(blocks).not.toContain("ext:fe");
    expect(blocks).not.toContain("ext:ff:XMP DataXMP");
    expect(blocks).toContain("ext:ff:NETSCAPE2.0");
    expect(blocks.filter((b) => b === "image")).toHaveLength(2);
    expect(blocks.at(-1)).toBe("trailer");
    expect(containsText(out, "trailer")).toBe(false);
    expect(sniffImageType(out)).toBe("image/gif");
  });

  it("refuses a GIF with no image", () => {
    expect(stripImageMetadata(src.subarray(0, 13), "image/gif")).toBeNull();
  });
});

describe("stripImageMetadata", () => {
  it("refuses a type it does not know", () => {
    expect(stripImageMetadata(readFixture("gps.png"), "image/svg+xml")).toBeNull();
  });
});
