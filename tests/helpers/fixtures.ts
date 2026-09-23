/**
 * Binary fixtures under tests/fixtures/images, made with Pillow 12 (real
 * encoder output, then metadata spliced in where Pillow cannot write it):
 *
 *  - gps.jpg: 64x32 baseline JPEG with restart markers. Exif (Orientation 6,
 *    Make/Model "TestMake"/"TestPhone Pro", DateTime, GPS 47d45'N 7d20'E),
 *    XMP with GPS, COM "taken at home", ICC sRGB, IPTC (APP13 "Mulhouse,
 *    France"), an APP2 MPF, and a second JPEG after EOI (like an MPO).
 *  - gps-progressive.jpg: 48x48 progressive JPEG (10 scans), Exif
 *    Orientation 1 with the same GPS and device tags.
 *  - gps.png: 16x16 RGBA with eXIf (GPS), tEXt "Comment", zTXt "Location",
 *    iTXt XMP, iCCP, tIME, and bytes after IEND.
 *  - gps.webp: 16x16 VP8X with EXIF (GPS), XMP, ICCP, and bytes after the
 *    RIFF payload.
 *  - gps.gif: two-frame GIF89a looping (NETSCAPE2.0), comment "taken at
 *    home", an "XMP DataXMP" application extension with its magic trailer,
 *    and bytes after the trailer.
 */
const nodeProcess = (globalThis as any).process;
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs") as {
  readFileSync(path: URL): Uint8Array;
};

export function readFixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../fixtures/images/${name}`, (import.meta as { url?: string }).url)),
  );
}

/** True when `bytes` contains `text` (latin1, byte for byte). */
export function containsText(bytes: Uint8Array, text: string): boolean {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s.includes(text);
}
