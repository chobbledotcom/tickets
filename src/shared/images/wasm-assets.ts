type Asset = {
  exportName: "jpegDec" | "pngDec" | "webpDec" | "webpEnc" | "webpEncSimd";
  specifier: string;
};

export const ASSETS = [
  {
    exportName: "jpegDec",
    specifier: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  },
  {
    exportName: "pngDec",
    specifier: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  },
  {
    exportName: "webpDec",
    specifier: "@jsquash/webp/codec/dec/webp_dec.wasm",
  },
  {
    exportName: "webpEnc",
    specifier: "@jsquash/webp/codec/enc/webp_enc.wasm",
  },
  {
    exportName: "webpEncSimd",
    specifier: "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
  },
] as const satisfies readonly Asset[];

export const readAsset = (asset: Asset): Uint8Array =>
  Deno.readFileSync(new URL(import.meta.resolve(asset.specifier)));
