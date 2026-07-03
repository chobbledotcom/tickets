# Vendored jSquash codec WebAssembly

These `.wasm` binaries are the codec modules from the
[jSquash](https://github.com/jamsinclair/jSquash) packages (which vendor
Google's Squoosh codecs — mozjpeg, libpng/oxipng, libwebp). They are
Apache-2.0 licensed, like the rest of Squoosh.

They are checked in so the image pipeline (`src/shared/images/`) loads the exact
codec bytes it was tested against — with no runtime `fetch` and no dependency on
the jSquash glue code's own `.wasm` location logic, which does not work inside
the single-file Bunny edge bundle (esbuild `platform: "browser"`, no
filesystem).

| File                | Source package / path                                  |
| ------------------- | ------------------------------------------------------ |
| `jpeg_dec.wasm`     | `@jsquash/jpeg` → `codec/dec/mozjpeg_dec.wasm`         |
| `png_dec.wasm`      | `@jsquash/png` → `codec/pkg/squoosh_png_bg.wasm`       |
| `webp_dec.wasm`     | `@jsquash/webp` → `codec/dec/webp_dec.wasm`            |
| `webp_enc.wasm`     | `@jsquash/webp` → `codec/enc/webp_enc.wasm`            |
| `webp_enc_simd.wasm`| `@jsquash/webp` → `codec/enc/webp_enc_simd.wasm`       |

To refresh after a dependency bump, re-copy each file from the corresponding
package in the Deno npm cache (`deno info` prints the cache root) and keep the
pinned versions in `deno.json` in sync.

`src/shared/images/wasm-bytes.ts` reads these at codec-init time in dev/test;
the edge build inlines them as base64 (`scripts/build-edge.ts`).
