import jpegEncode from "@jsquash/jpeg/encode.js";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  decodeImage,
  encodeWebp,
  pickEncoderBytes,
} from "#shared/images/codecs.ts";
import {
  expectWebpContainer,
  makeTestPng,
} from "#test/test-utils/test-image.ts";

describe("pickEncoderBytes", () => {
  test("selects the SIMD build when SIMD is supported, scalar otherwise", () => {
    const simdBytes = pickEncoderBytes(true);
    const scalarBytes = pickEncoderBytes(false);
    expect(scalarBytes.length).toBeGreaterThan(0);
    // The SIMD build is a distinct, larger binary — pins which arm is which.
    expect(simdBytes.length).toBeGreaterThan(scalarBytes.length);
  });
});

describe("decodeImage", () => {
  test("decodes PNG bytes to RGBA of the right dimensions", async () => {
    const png = await makeTestPng(20, 12);
    const decoded = await decodeImage(png, "image/png");
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(12);
    expect(decoded.data.length).toBe(20 * 12 * 4);
  });

  test("decodes JPEG bytes via the image/jpeg codec", async () => {
    const png = await makeTestPng(20, 12);
    const rgba = await decodeImage(png, "image/png");
    const jpeg = new Uint8Array(
      await jpegEncode(rgba as unknown as ImageData, { quality: 90 }),
    );
    const decoded = await decodeImage(jpeg, "image/jpeg");
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(12);
  });

  test("round-trips through WebP decode", async () => {
    const png = await makeTestPng(16, 16);
    const decoded = await decodeImage(png, "image/png");
    const webp = await encodeWebp(decoded, 90);
    const back = await decodeImage(webp, "image/webp");
    expect(back.width).toBe(16);
    expect(back.height).toBe(16);
  });
});

describe("encodeWebp", () => {
  test("produces a valid WebP container", async () => {
    const png = await makeTestPng(24, 24);
    const decoded = await decodeImage(png, "image/png");
    const webp = await encodeWebp(decoded, 80);
    expectWebpContainer(webp);
  });

  test("lower quality yields a smaller file for the same image", async () => {
    // A noisy image so quality actually changes the encoded size.
    const png = await makeTestPng(64, 64, (x, y) => [
      (x * 37 + y * 17) % 256,
      (x * 5 + y * 91) % 256,
      (x * 53 + y * 3) % 256,
      255,
    ]);
    const decoded = await decodeImage(png, "image/png");
    const high = await encodeWebp(decoded, 90);
    const low = await encodeWebp(decoded, 10);
    expect(low.length).toBeLessThan(high.length);
  });
});
