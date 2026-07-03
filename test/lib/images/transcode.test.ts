import jpegEncode from "@jsquash/jpeg/encode.js";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decodeImage } from "#shared/images/codecs.ts";
import {
  FULL_IMAGE_TARGET,
  THUMB_IMAGE_TARGET,
} from "#shared/images/targets.ts";
import { transcodeToWebp } from "#shared/images/transcode.ts";
import { makeTestPng } from "#test/test-utils/test-image.ts";

/** Assert bytes are a WebP container, then return its decoded dimensions. */
const webpDims = async (
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> => {
  expect([...bytes.slice(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
  expect([...bytes.slice(8, 12)]).toEqual([0x57, 0x45, 0x42, 0x50]);
  const decoded = await decodeImage(bytes, "image/webp");
  return { height: decoded.height, width: decoded.width };
};

describe("transcodeToWebp", () => {
  test("produces one WebP per target, each downscaled to its max width", async () => {
    const png = await makeTestPng(2000, 1000);
    const [full, thumb] = await transcodeToWebp(png, "image/png", [
      FULL_IMAGE_TARGET,
      THUMB_IMAGE_TARGET,
    ]);
    // 2000x1000 → capped at 1600 and 480 respectively, aspect preserved.
    expect(await webpDims(full!)).toEqual({ height: 800, width: 1600 });
    expect(await webpDims(thumb!)).toEqual({ height: 240, width: 480 });
  });

  test("does not upscale a source smaller than the target width", async () => {
    const png = await makeTestPng(300, 150);
    const [thumb] = await transcodeToWebp(png, "image/png", [
      THUMB_IMAGE_TARGET,
    ]);
    // 300 < 480, so dimensions are unchanged.
    expect(await webpDims(thumb!)).toEqual({ height: 150, width: 300 });
  });

  test("decodes a JPEG source", async () => {
    const png = await makeTestPng(120, 90);
    const decoded = await decodeImage(png, "image/png");
    const jpeg = new Uint8Array(
      await jpegEncode(decoded as unknown as ImageData, { quality: 90 }),
    );
    const [full] = await transcodeToWebp(jpeg, "image/jpeg", [
      FULL_IMAGE_TARGET,
    ]);
    // Small source, unchanged size, valid WebP out.
    expect(await webpDims(full!)).toEqual({ height: 90, width: 120 });
  });

  test("returns an empty list when given no targets", async () => {
    const png = await makeTestPng(40, 40);
    expect(await transcodeToWebp(png, "image/png", [])).toEqual([]);
  });
});
