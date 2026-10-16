/**
 * Test image generators.
 *
 * `makeTestPng` builds a real, valid RGBA PNG from a pixel function using
 * `CompressionStream` for the IDAT — so image-pipeline tests can decode/resize/
 * transcode genuine bytes rather than fixtures checked into the repo. The PNG
 * encoder is deliberately minimal (8-bit RGBA, single IDAT, no filtering) but
 * spec-correct: real decoders (jSquash / the browser) accept its output.
 */

import { expect } from "@std/expect";

const TEST_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMDAwMDAwQEBAQFBQUFBQcHBgYHBwsICQgJCAsRCwwLCwwLEQ8SDw4PEg8bFRMTFRsfGhkaHyYiIiYwLTA+PlQBAwMDAwMDBAQEBAUFBQUFBwcGBgcHCwgJCAkICxELDAsLDAsRDxIPDg8SDxsVExMVGx8aGRofJiIiJjAtMD4+VP/CABEIAFoAeAMBEQACEQEDEQH/xAApAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAcI/9oADAMBAAIQAxAAAACC0bAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAHD/2gAIAQEAAT8ANP/EABQRAQAAAAAAAAAAAAAAAAAAAHD/2gAIAQIBAT8ANP/EABQRAQAAAAAAAAAAAAAAAAAAAHD/2gAIAQMBAT8ANP/Z";

/** A fixed valid 120×90 JPEG, avoiding an encoder-WASM fetch in test setup. */
export const testJpeg = (): Uint8Array => Uint8Array.fromBase64(TEST_JPEG);

const SOI_LENGTH = 2;
const EXIF_TIFF_PAYLOAD = Uint8Array.from([
  // TIFF header: little-endian byte order, magic 42, IFD0 at offset 8.
  0x49,
  0x49,
  0x2a,
  0x00,
  0x08,
  0x00,
  0x00,
  0x00,
  // IFD0: one entry.
  0x01,
  0x00,
  // Tag 0x0112 (orientation), type SHORT, count 1, value follows inline.
  0x12,
  0x01,
  0x03,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // placeholder: the orientation value fills bytes 8-9
  // Next-IFD offset: none.
  0x00,
  0x00,
  0x00,
  0x00,
]);

const EXIF_HEADER_BYTES = Uint8Array.from([
  0x45,
  0x78,
  0x69,
  0x66,
  0x00,
  0x00, // "Exif\0\0"
]);

/** Insert an APP1 segment carrying an Exif orientation tag after the JPEG's
 * first APP0 segment, returning new bytes. The value is the EXIF orientation
 * (1–8) the camera would have written. */
const insertExifOrientation = (
  jpeg: Uint8Array,
  orientation: number,
): Uint8Array => {
  const payload = new Uint8Array(
    EXIF_HEADER_BYTES.length + EXIF_TIFF_PAYLOAD.length,
  );
  payload.set(EXIF_HEADER_BYTES);
  payload.set(EXIF_TIFF_PAYLOAD, EXIF_HEADER_BYTES.length);
  // The orientation value sits in the entry's inline value field.
  payload[EXIF_HEADER_BYTES.length + 18] = orientation;

  // Walk the segment chain from SOI to the first non-APPn marker; APP1 goes
  // right there, after any APP0 the encoder wrote.
  let insertAt = SOI_LENGTH;
  let cursor = SOI_LENGTH;
  while (cursor + 4 <= jpeg.length) {
    if (jpeg[cursor] !== 0xff) break;
    const marker = jpeg[cursor + 1]!;
    if (marker === 0xe1) break; // the file already carries Exif: leave it be
    if (marker < 0xe0 || marker > 0xef) break; // no longer an APPn segment
    const length = (jpeg[cursor + 2]! << 8) | jpeg[cursor + 3]!;
    insertAt = cursor + 2 + length;
    cursor = insertAt;
  }

  const segmentLength = payload.length + 2;
  const out = new Uint8Array(jpeg.length + 2 + segmentLength);
  out.set(jpeg.subarray(0, insertAt));
  out[insertAt] = 0xff;
  out[insertAt + 1] = 0xe1;
  out[insertAt + 2] = segmentLength >> 8;
  out[insertAt + 3] = segmentLength & 0xff;
  out.set(payload, insertAt + 4);
  out.set(jpeg.subarray(insertAt), insertAt + 4 + payload.length);
  return out;
};

/** A real 120×90 JPEG carrying an EXIF orientation tag, so pipeline tests can
 * exercise the tag a camera writes. Orientation 6 stores the pixels a
 * quarter-turn counter-clockwise of the upright view, the most common camera
 * value. */
export const orientedTestJpeg = (orientation: number): Uint8Array =>
  insertExifOrientation(testJpeg(), orientation);

/** Assert `bytes` is a WebP container ("RIFF"…"WEBP" header). */
export const expectWebpContainer = (bytes: Uint8Array): void => {
  expect([...bytes.slice(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  expect([...bytes.slice(8, 12)]).toEqual([0x57, 0x45, 0x42, 0x50]); // "WEBP"
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const deflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(data as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return new Uint8Array([...len, ...body, ...crc]);
};

/** RGBA tuple `[r, g, b, a]`, each 0–255. */
export type Rgba = [number, number, number, number];

/**
 * Build a valid `width`×`height` 8-bit RGBA PNG. `fill(x, y)` returns the RGBA
 * for each pixel (defaults to an opaque diagonal gradient).
 */
export const makeTestPng = async (
  width: number,
  height: number,
  fill: (x: number, y: number) => Rgba = (x, y) => [
    (x * 255) / width,
    (y * 255) / height,
    128,
    255,
  ],
): Promise<Uint8Array> => {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4;
      const [r, g, b, a] = fill(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflate(raw)),
    pngChunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
