/**
 * The `.wasm` bytes are initialised manually rather than left to jSquash's own
 * loader. That loader relies on `fetch` and filesystem paths that do not
 * resolve inside the single-file Bunny edge bundle.
 *
 * This module is dynamically imported by the upload path, never at cold boot,
 * so the ~1MB of codec wasm compiles lazily and once per isolate. A transient
 * CDN failure stays retryable.
 *
 * The SIMD build is chosen when the runtime reports SIMD support. This mirrors
 * jSquash's own selection so the glue code and the wasm module always agree.
 */

import jpegDecode, { init as jpegInit } from "@jsquash/jpeg/decode.js";
import pngDecode, { init as pngInit } from "@jsquash/png/decode.js";
import pngEncode, { init as pngEncodeInit } from "@jsquash/png/encode.js";
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
 * SIMD build is meaningfully faster where available. The scalar build is the
 * portable fallback. Split out so both arms are unit-testable without needing
 * to force `simd()`'s result. */
export const pickEncoderBytes = async (
  useSimd: boolean,
): Promise<Uint8Array> => (useSimd ? webpEncSimdBytes() : webpEncBytes());

/** One encoder over RGBA pixels. The PNG encoder ignores the quality option. */
type PixelEncoder = (
  image: RawImage,
  options?: { quality?: number },
) => Promise<ArrayBuffer>;

/** The compiled codecs, so an encoder can take the bundle as one value. */
interface Codecs {
  decode: Record<DecodableMime, (data: ArrayBuffer) => Promise<ImageData>>;
  encodePng: PixelEncoder;
  encodeWebp: PixelEncoder;
}

/** Compile all codec modules and hand each to its jSquash init once successfully. */
const ensureCodecs = onceSuccessful(async (): Promise<Codecs> => {
  const encBytes = await pickEncoderBytes(await simd());
  const [pngMod, jpegMod, webpDecMod, webpEncMod] = await Promise.all([
    compileWasm(pngDecBytes()),
    compileWasm(jpegDecBytes()),
    compileWasm(webpDecBytes()),
    compileWasm(encBytes),
  ]);
  await Promise.all([
    pngInit(pngMod),
    pngEncodeInit(pngMod),
    jpegInit(jpegMod),
    webpDecInit(webpDecMod),
    webpEncInit(webpEncMod),
  ]);
  return {
    decode: DECODERS,
    encodePng: encodePngPixels,
    encodeWebp: encodeWebpPixels,
  };
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
const encodeWebpPixels = webpEncode as PixelEncoder;

/** The PNG encoder types its input as DOM `ImageData`, which adds only the
 * colour space tag to the pixels `RawImage` carries. The array buffer is a
 * plain `ArrayBuffer` here, as every decoded image is. */
const encodePngPixels: PixelEncoder = (image) =>
  pngEncode({
    colorSpace: "srgb",
    data: image.data as Uint8ClampedArray<ArrayBuffer>,
    height: image.height,
    width: image.width,
  });

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

/** Run one encoder over RGBA pixels and return its bytes. */
const encodePixels = async (
  run: (codecs: Codecs) => Promise<ArrayBuffer>,
): Promise<Uint8Array> => new Uint8Array(await run(await ensureCodecs()));

/** Encode RGBA pixels to PNG. The module that decodes PNG also encodes it, so
 * no second wasm binary is needed. */
export const encodePng = (image: RawImage): Promise<Uint8Array> =>
  encodePixels((codecs) => codecs.encodePng(image));

/** Encode RGBA pixels to WebP at the given quality (0–100). */
export const encodeWebp = (
  image: RawImage,
  quality: number,
): Promise<Uint8Array> =>
  encodePixels((codecs) => codecs.encodeWebp(image, { quality }));
