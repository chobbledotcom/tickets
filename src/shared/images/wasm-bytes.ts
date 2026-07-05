/**
 * Raw bytes of the jSquash codec WebAssembly modules.
 *
 * The JS glue comes from `@jsquash/*`, but those packages also ship matching
 * `.wasm` sidecars. Development and tests resolve those sidecars through Deno's
 * locked npm resolver and read the package files directly. Single-file deploy
 * bundles have no filesystem, so the build replaces this module with base64
 * literals produced from the same package sidecars.
 *
 * Either way the exported interface is identical: five `Uint8Array` getters,
 * read lazily so importing this module does no filesystem work until a codec is
 * actually initialised.
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
