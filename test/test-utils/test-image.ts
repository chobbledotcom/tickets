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
