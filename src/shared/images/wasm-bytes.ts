/**
 * Development and tests read the `.wasm` sidecars from the npm packages. A
 * single-file deploy bundle has no filesystem, so THE BUILD REPLACES THIS
 * MODULE with base64 literals from the same sidecars.
 *
 * Either way the exported interface is identical, and the getters are lazy, so
 * importing this module does no filesystem work until a codec initialises.
 */

import { ASSETS, readAsset } from "./wasm-assets.ts";

const [JPEG_DEC, PNG_DEC, WEBP_DEC, WEBP_ENC, WEBP_ENC_SIMD] = ASSETS;

/** mozjpeg decoder (JPEG → RGBA). */
export const jpegDec = (): Uint8Array => readAsset(JPEG_DEC);

/** squoosh PNG decoder (PNG → RGBA). */
export const pngDec = (): Uint8Array => readAsset(PNG_DEC);

/** libwebp decoder (WebP → RGBA). */
export const webpDec = (): Uint8Array => readAsset(WEBP_DEC);

/** libwebp encoder, scalar build (RGBA → WebP). */
export const webpEnc = (): Uint8Array => readAsset(WEBP_ENC);

/** libwebp encoder, SIMD build — used when the runtime reports WASM SIMD. */
export const webpEncSimd = (): Uint8Array => readAsset(WEBP_ENC_SIMD);
