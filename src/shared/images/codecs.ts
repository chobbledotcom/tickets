/**
 * jSquash WebAssembly codec wrappers: decode JPEG/PNG/WebP to RGBA, encode
 * RGBA to WebP.
 *
 * The `.wasm` bytes are vendored (`./wasm`) and initialised manually rather than
 * left to jSquash's own loader, which relies on `fetch`/filesystem paths that do
 * not resolve inside the single-file Bunny edge bundle. Initialisation is
 * `once()`-guarded and only happens on the first transcode — this module is
 * dynamically imported by the upload path, never at cold boot — so the ~1MB of
 * codec wasm is compiled lazily and exactly once per isolate.
 *
 * The WebP encoder ships two builds; we pick the SIMD one when the runtime
 * reports WASM SIMD support, matching jSquash's own selection so the glue code
 * and the wasm module always agree.
 */

import jpegDecode, { init as jpegInit } from "@jsquash/jpeg/decode.js";
import pngDecode, { init as pngInit } from "@jsquash/png/decode.js";
import webpDecode, { init as webpDecInit } from "@jsquash/webp/decode.js";
import webpEncode, { init as webpEncInit } from "@jsquash/webp/encode.js";
import { simd } from "wasm-feature-detect";
import { once } from "#fp";
import type { DecodableMime, RawImage } from "./types.ts";
import {
  jpegDecWasm,
  pngDecWasm,
  webpDecWasm,
  webpEncSimdWasm,
  webpEncWasm,
} from "./wasm-bytes.ts";

/** Compile all codec modules and hand each to its jSquash init, exactly once. */
const ensureCodecs = once(
  async (): Promise<void> => {
    const encWasm = (await simd()) ? webpEncSimdWasm() : webpEncWasm();
    const [pngMod, jpegMod, webpDecMod, webpEncMod] = await Promise.all([
      WebAssembly.compile(pngDecWasm()),
      WebAssembly.compile(jpegDecWasm()),
      WebAssembly.compile(webpDecWasm()),
      WebAssembly.compile(encWasm),
    ]);
    await Promise.all([
      pngInit(pngMod),
      jpegInit(jpegMod),
      webpDecInit(webpDecMod),
      webpEncInit(webpEncMod),
    ]);
  },
);

/** Decoder per accepted MIME type — exhaustive, so a new format is a compile error. */
const DECODERS: Record<
  DecodableMime,
  (data: ArrayBuffer) => Promise<ImageData>
> = {
  "image/jpeg": jpegDecode,
  "image/png": pngDecode,
  "image/webp": webpDecode,
};

/** Decode encoded image bytes of the given MIME type into RGBA pixels. */
export const decodeImage = async (
  data: Uint8Array,
  mime: DecodableMime,
): Promise<RawImage> => {
  await ensureCodecs();
  return DECODERS[mime](data.buffer as ArrayBuffer);
};

/** Encode RGBA pixels to WebP at the given quality (0–100). */
export const encodeWebp = async (
  image: RawImage,
  quality: number,
): Promise<Uint8Array> => {
  await ensureCodecs();
  return new Uint8Array(await webpEncode(image, { quality }));
};
