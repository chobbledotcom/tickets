import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ASSETS, readAsset } from "#shared/images/wasm-assets.ts";
import {
  jpegDec,
  pngDec,
  webpDec,
  webpEnc,
  webpEncSimd,
} from "#shared/images/wasm-bytes.ts";

type ExportName = (typeof ASSETS)[number]["exportName"];

const EXPECTED_EXPORTS: ExportName[] = [
  "jpegDec",
  "pngDec",
  "webpDec",
  "webpEnc",
  "webpEncSimd",
];

const EXPECTED_SPECIFIERS = [
  "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  "@jsquash/webp/codec/dec/webp_dec.wasm",
  "@jsquash/webp/codec/enc/webp_enc.wasm",
  "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
];

const WASM_MAGIC = [0, 97, 115, 109];

const expectWasm = (bytes: Uint8Array): void => {
  expect([...bytes.slice(0, 4)]).toEqual(WASM_MAGIC);
  expect(bytes.length).toBeGreaterThan(1_000);
};

describe("jSquash wasm sidecars", () => {
  test("declares package sidecar paths instead of repo-local wasm files", () => {
    expect(ASSETS.map((asset) => asset.exportName)).toEqual(EXPECTED_EXPORTS);
    expect(ASSETS.map((asset) => asset.specifier)).toEqual(EXPECTED_SPECIFIERS);
  });

  test("reads every declared sidecar through Deno package resolution", () => {
    for (const asset of ASSETS) {
      expectWasm(readAsset(asset));
    }
  });

  test("public getters return the matching sidecar bytes", () => {
    const getters: Record<ExportName, () => Uint8Array> = {
      jpegDec,
      pngDec,
      webpDec,
      webpEnc,
      webpEncSimd,
    };
    for (const asset of ASSETS) {
      expect(getters[asset.exportName]().length).toBe(readAsset(asset).length);
    }
  });
});
