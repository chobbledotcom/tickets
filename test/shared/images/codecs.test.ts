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
  testJpeg,
} from "#test/test-utils/test-image.ts";

describe("pickEncoderBytes", () => {
  test("selects the SIMD build when SIMD is supported, scalar otherwise", async () => {
    const simdBytes = await pickEncoderBytes(true);
    const scalarBytes = await pickEncoderBytes(false);
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

  test("decodes only the bytes inside a subarray view", async () => {
    const png = await makeTestPng(18, 11);
    const padded = new Uint8Array(png.length + 2);
    padded[0] = 255;
    padded.set(png, 1);
    padded[padded.length - 1] = 255;

    const decoded = await decodeImage(
      padded.subarray(1, padded.length - 1),
      "image/png",
    );
    expect(decoded.width).toBe(18);
    expect(decoded.height).toBe(11);
  });

  test("decodes JPEG bytes via the image/jpeg codec", async () => {
    const decoded = await decodeImage(testJpeg(), "image/jpeg");
    expect(decoded.width).toBe(120);
    expect(decoded.height).toBe(90);
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
