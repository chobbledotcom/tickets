import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resizeAreaAverage, resizeToMaxWidth } from "#shared/images/resize.ts";
import type { RawImage } from "#shared/images/types.ts";

/** Build a RawImage from a flat list of RGBA tuples, row-major. */
const image = (
  width: number,
  height: number,
  pixels: ReadonlyArray<readonly [number, number, number, number]>,
): RawImage => ({
  data: Uint8ClampedArray.from(pixels.flat()),
  height,
  width,
});

/** RGBA of the pixel at (x, y). */
const pixelAt = (img: RawImage, x: number, y: number): number[] => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};

describe("resizeToMaxWidth", () => {
  test("returns the same image untouched when already within the cap", () => {
    const img = image(4, 3, Array(12).fill([10, 20, 30, 255]));
    // Identity by reference — no reallocation, and never upscales.
    expect(resizeToMaxWidth(img, 4)).toBe(img);
    expect(resizeToMaxWidth(img, 100)).toBe(img);
  });

  test("caps width and scales height to preserve aspect ratio", () => {
    const img = image(100, 50, Array(5000).fill([0, 0, 0, 255]));
    const out = resizeToMaxWidth(img, 40);
    expect(out.width).toBe(40);
    expect(out.height).toBe(20);
  });

  test("floors the scaled height at 1px for extreme aspect ratios", () => {
    const img = image(100, 1, Array(100).fill([0, 0, 0, 255]));
    const out = resizeToMaxWidth(img, 10);
    expect(out.width).toBe(10);
    // round(1 * 10 / 100) = 0, clamped up to 1 so the image never vanishes.
    expect(out.height).toBe(1);
  });
});

describe("resizeAreaAverage", () => {
  test("averages a 2x2 block down to its mean colour", () => {
    const img = image(2, 2, [
      [40, 0, 0, 255],
      [0, 40, 0, 255],
      [0, 0, 40, 255],
      [80, 80, 80, 255],
    ]);
    const out = resizeAreaAverage(img, 1, 1);
    // Per-channel mean of the four opaque pixels.
    expect(pixelAt(out, 0, 0)).toEqual([30, 30, 30, 255]);
  });

  test("weights colour by alpha so transparent pixels don't dilute it", () => {
    const img = image(2, 1, [
      [255, 0, 0, 255], // opaque red
      [0, 255, 0, 0], // fully transparent (green is irrelevant)
    ]);
    const out = resizeAreaAverage(img, 1, 1);
    // Alpha is the straight mean (255 + 0)/2 = 127.5 → 128; the colour is the
    // red, undiluted by the transparent pixel's phantom green.
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  test("leaves colour black where the averaged alpha is zero", () => {
    const img = image(2, 2, [
      [255, 128, 64, 0],
      [10, 20, 30, 0],
      [1, 2, 3, 0],
      [9, 8, 7, 0],
    ]);
    const out = resizeAreaAverage(img, 1, 1);
    // Every source pixel is fully transparent, so there is no colour to
    // un-premultiply — RGB stays 0, alpha 0.
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});
