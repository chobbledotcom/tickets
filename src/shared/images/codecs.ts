/**
 * The `.wasm` bytes are initialised manually rather than left to jSquash's own
 * loader, which relies on `fetch` and filesystem paths that do not resolve
 * inside the single-file Bunny edge bundle.
 *
 * This module is dynamically imported by the upload path, never at cold boot,
 * so the ~1MB of codec wasm compiles lazily and once per isolate. A transient
 * CDN failure stays retryable.
 *
 * The SIMD build is chosen when the runtime reports SIMD support, which mirrors
 * jSquash's own selection so the glue code and the wasm module always agree.
 */

import jpegDecode, { init as jpegInit } from "@jsquash/jpeg/decode.js";
import pngDecode, { init as pngInit } from "@jsquash/png/decode.js";
import webpDecode, { init as webpDecInit } from "@jsquash/webp/decode.js";
import webpEncode, { init as webpEncInit } from "@jsquash/webp/encode.js";
import { simd } from "wasm-feature-detect";
import { onceSuccessful } from "#shared/once-successful.ts";
import { applyExifOrientation, readJpegOrientation } from "./exif.ts";
import type { DecodableMime } from "./formats.ts";
import type { RawImage } from "./types.ts";
import {
  jpegDec as jpegDecBytes,
  pngDec as pngDecBytes,
  webpDec as webpDecBytes,
  webpEnc as webpEncBytes,
  webpEncSimd as webpEncSimdBytes,
} from "./wasm-bytes.ts";

/** Compile package codec bytes into a WebAssembly.Module. */
const compileWasm = async (
  bytes: Uint8Array | Promise<Uint8Array>,
): Promise<WebAssembly.Module> =>
  WebAssembly.compile((await bytes) as BufferSource);

/** Pick the WebP encoder build matching the runtime's WASM SIMD support. The
 * SIMD build is meaningfully faster where available; the scalar build is the
 * portable fallback. Split out so both arms are unit-testable without needing
 * to force `simd()`'s result. */
export const pickEncoderBytes = async (
  useSimd: boolean,
): Promise<Uint8Array> => (useSimd ? webpEncSimdBytes() : webpEncBytes());

/** Compile all codec modules and hand each to its jSquash init once successfully. */
const ensureCodecs = onceSuccessful(async () => {
  const encBytes = await pickEncoderBytes(await simd());
  const [pngMod, jpegMod, webpDecMod, webpEncMod] = await Promise.all([
    compileWasm(pngDecBytes()),
    compileWasm(jpegDecBytes()),
    compileWasm(webpDecBytes()),
    compileWasm(encBytes),
  ]);
  await Promise.all([
    pngInit(pngMod),
    jpegInit(jpegMod),
    webpDecInit(webpDecMod),
    webpEncInit(webpEncMod),
  ]);
  return { decode: DECODERS, encode: encodeWebpPixels };
});

/** Decoder per accepted MIME type — exhaustive, so a new format is a compile error. */
const DECODERS: Record<
  DecodableMime,
  (data: ArrayBuffer) => Promise<ImageData>
> = {
  "image/jpeg": jpegDecode,
  "image/png": pngDecode,
  "image/webp": webpDecode,
};

/** jSquash types its encoder against the full DOM `ImageData` but only ever
 * reads the pixels `RawImage` carries, so pin that honest shape once here. */
const encodeWebpPixels = webpEncode as (
  image: RawImage,
  options?: { quality?: number },
) => Promise<ArrayBuffer>;

/** Decode encoded image bytes of the given MIME type into RGBA pixels.
 *
 * A JPEG's pixels are stored in scanline order. The upright view lives in its
 * EXIF orientation tag, which the wasm decoder ignores. The tag is read and
 * baked into the pixels, so every re-encoded variant displays upright. PNG
 * and WebP uploads carry no camera orientation. */
export const decodeImage = async (
  data: Uint8Array,
  mime: DecodableMime,
): Promise<RawImage> => {
  const codecs = await ensureCodecs();
  const start = data.byteOffset;
  const encoded = data.buffer.slice(start, start + data.byteLength);
  const image = await codecs.decode[mime](encoded as ArrayBuffer);
  return mime === "image/jpeg"
    ? applyExifOrientation(image, readJpegOrientation(data))
    : image;
};

/** Encode RGBA pixels to WebP at the given quality (0–100). */
export const encodeWebp = async (
  image: RawImage,
  quality: number,
): Promise<Uint8Array> => {
  const codecs = await ensureCodecs();
  return new Uint8Array(await codecs.encode(image, { quality }));
};
