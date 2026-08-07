import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  cropElementLayerPng,
  elementTrimBounds,
  trimElementPng,
} from "#scripts/screenshots/image.ts";
import {
  solidPng,
  whitePngWithBlackBox,
} from "#test/scripts/screenshots-fixture.ts";

const cropElementLayer = async (background: {
  alpha?: number;
  b: number;
  g: number;
  r: number;
}) => {
  const source = await whitePngWithBlackBox();
  const bounds = await elementTrimBounds(source, { b: 255, g: 255, r: 255 });
  return {
    bounds,
    result: await cropElementLayerPng(source, bounds, background),
  };
};

describe("screenshot element image", () => {
  test("trims the element and adds 32 pixel padding", async () => {
    const result = await trimElementPng(await whitePngWithBlackBox(), {
      b: 255,
      g: 255,
      r: 255,
    });

    expect(await sharp(result).metadata()).toEqual(
      expect.objectContaining({ format: "png", height: 84, width: 94 }),
    );
  });

  test("rejects an image whose background was not trimmed", async () => {
    const source = await solidPng({ alpha: 1, b: 0, g: 0, r: 0 }, 10);

    await expect(
      trimElementPng(source, { b: 255, g: 255, r: 255 }),
    ).rejects.toThrow("has no visible content");
  });

  test("uses the normal image crop for a transparent layer", async () => {
    const { bounds, result } = await cropElementLayer({
      alpha: 0,
      b: 0,
      g: 0,
      r: 0,
    });

    expect(bounds).toEqual({ height: 20, left: 35, top: 40, width: 30 });
    expect(await sharp(result).metadata()).toEqual(
      expect.objectContaining({ height: 84, width: 94 }),
    );
  });

  test("uses the page color around a cropped background layer", async () => {
    const { result } = await cropElementLayer({
      b: 255,
      g: 255,
      r: 255,
    });

    expect([
      ...(await sharp(result)
        .ensureAlpha()
        .extract({
          height: 1,
          left: 0,
          top: 0,
          width: 1,
        })
        .raw()
        .toBuffer()),
    ]).toEqual([255, 255, 255, 255]);
  });

  test("rejects bounds when no edge can be trimmed", async () => {
    const source = await solidPng({ alpha: 1, b: 0, g: 0, r: 0 }, 10);

    await expect(
      elementTrimBounds(source, { b: 255, g: 255, r: 255 }),
    ).rejects.toThrow("has no visible content");
  });
});
