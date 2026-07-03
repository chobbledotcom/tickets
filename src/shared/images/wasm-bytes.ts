/**
 * Raw bytes of the vendored jSquash codec WebAssembly modules.
 *
 * Development and tests read the `.wasm` files from disk (relative to this
 * module). The Bunny edge runtime has no filesystem, so the edge build
 * (`scripts/build-edge.ts`, `inlineWasmPlugin`) replaces this module with one
 * that returns the same bytes baked in as base64 — exactly the shape the
 * `inline-assets` / `build-info` plugins already use for other filesystem reads.
 * Either way the exported interface is identical: five `Uint8Array` getters,
 * read lazily so importing this module does no filesystem work until a codec is
 * actually initialised (the transcode path is dynamically imported on the first
 * image upload, never at cold boot).
 *
 * See `src/shared/images/wasm/README.md` for how the files are vendored.
 */

const read = (name: string): Uint8Array =>
  Deno.readFileSync(new URL(`./wasm/${name}`, import.meta.url));

/** mozjpeg decoder (JPEG → RGBA). */
export const jpegDecWasm = (): Uint8Array => read("jpeg_dec.wasm");

/** squoosh PNG decoder (PNG → RGBA). */
export const pngDecWasm = (): Uint8Array => read("png_dec.wasm");

/** libwebp decoder (WebP → RGBA). */
export const webpDecWasm = (): Uint8Array => read("webp_dec.wasm");

/** libwebp encoder, scalar build (RGBA → WebP). */
export const webpEncWasm = (): Uint8Array => read("webp_enc.wasm");

/** libwebp encoder, SIMD build — used when the runtime reports WASM SIMD. */
export const webpEncSimdWasm = (): Uint8Array => read("webp_enc_simd.wasm");
