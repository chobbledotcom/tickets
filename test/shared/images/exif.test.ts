import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyExifOrientation,
  readJpegOrientation,
} from "#shared/images/exif.ts";
import type { RawImage } from "#shared/images/types.ts";

/** A 3×2 image whose pixels name their position, so every transform's output
 * is readable at a glance: pixel (x, y) is [y*10+x, 0, 0, 255]. */
const wideImage = (): RawImage => ({
  data: new Uint8ClampedArray([
    // Row 0: 0, 1, 2
    0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255,
    // Row 1: 10, 11, 12
    10, 0, 0, 255, 11, 0, 0, 255, 12, 0, 0, 255,
  ]),
  height: 2,
  width: 3,
});

/** The red channel of every output pixel, row-major. */
const reds = (image: RawImage): number[] =>
  Array.from(image.data).filter((_, index) => index % 4 === 0);

/** Wrap raw JPEG bytes in a hand-built APP1 Exif segment whose IFD0 carries
 * the given orientation, mirroring what a camera writes. */
const jpegWithOrientation = (orientation: number): Uint8Array =>
  Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xe1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0xd9,
  ]);

describe("readJpegOrientation", () => {
  test("reads the orientation tag from a little-endian TIFF", () => {
    expect(readJpegOrientation(jpegWithOrientation(6))).toBe(6);
    expect(readJpegOrientation(jpegWithOrientation(1))).toBe(1);
    expect(readJpegOrientation(jpegWithOrientation(8))).toBe(8);
  });

  test("reads a big-endian TIFF", () => {
    const jpeg = jpegWithOrientation(6);
    const app1 = jpeg.indexOf(0x45); // "Exif"
    const tiff = app1 + 6;
    // Rewrite the TIFF block in big-endian byte order: MM, magic 42, IFD0 at
    // offset 8, the same single SHORT orientation entry, value 6.
    jpeg.set(
      Uint8Array.from([
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12,
        0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
        // A SHORT value is left-justified in the 4-byte field: 00 06 here.
        0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
      tiff,
    );
    expect(readJpegOrientation(jpeg)).toBe(6);
  });

  test("returns 1 for a JPEG without an Exif segment", () => {
    const plain = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ]);
    expect(readJpegOrientation(plain)).toBe(1);
  });

  test("returns 1 for a truncated or malformed Exif payload", () => {
    const truncated = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0xff, 0xd9,
    ]);
    expect(readJpegOrientation(truncated)).toBe(1);
    // An orientation value outside 1–8 is malformed, not a transform.
    expect(readJpegOrientation(jpegWithOrientation(9))).toBe(1);
  });

  test("returns 1 once the scan starts, with no Exif ahead of it", () => {
    const scanFirst = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x03, 0x00, 0xff, 0xe1,
      0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49,
    ]);
    expect(readJpegOrientation(scanFirst)).toBe(1);
  });
});

describe("applyExifOrientation", () => {
  test("returns the input unchanged for orientation 1", () => {
    const image = wideImage();
    expect(applyExifOrientation(image, 1)).toBe(image);
  });

  test("mirrors left-right for orientation 2", () => {
    expect(reds(applyExifOrientation(wideImage(), 2))).toEqual([
      2, 1, 0, 12, 11, 10,
    ]);
  });

  test("rotates 180° for orientation 3", () => {
    expect(reds(applyExifOrientation(wideImage(), 3))).toEqual([
      12, 11, 10, 2, 1, 0,
    ]);
  });

  test("mirrors top-bottom for orientation 4", () => {
    expect(reds(applyExifOrientation(wideImage(), 4))).toEqual([
      10, 11, 12, 0, 1, 2,
    ]);
  });

  test("transposes across the main diagonal for orientation 5", () => {
    const out = applyExifOrientation(wideImage(), 5);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    expect(reds(out)).toEqual([0, 10, 1, 11, 2, 12]);
  });

  test("rotates 90° clockwise for orientation 6", () => {
    const out = applyExifOrientation(wideImage(), 6);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    // Top-left (0) ends top-right: the upright view of a camera that held
    // the camera sideways.
    expect(reds(out)).toEqual([10, 0, 11, 1, 12, 2]);
  });

  test("mirrors across the anti-diagonal for orientation 7", () => {
    const out = applyExifOrientation(wideImage(), 7);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    expect(reds(out)).toEqual([12, 2, 11, 1, 10, 0]);
  });

  test("rotates 90° counter-clockwise for orientation 8", () => {
    const out = applyExifOrientation(wideImage(), 8);
    expect(out.width).toBe(2);
    expect(out.height).toBe(3);
    expect(reds(out)).toEqual([2, 12, 1, 11, 0, 10]);
  });
});
