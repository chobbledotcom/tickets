import sharp from "sharp";
import { wasImageTrimmed } from "#scripts/screenshots/checks.ts";
import type { Rgb } from "#scripts/screenshots/color.ts";
import { requireValue } from "#shared/required-value.ts";

const ELEMENT_PADDING = 32;

export interface ElementTrimBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

const padded = (background: Rgb & { alpha?: number }) => ({
  background,
  bottom: ELEMENT_PADDING,
  left: ELEMENT_PADDING,
  right: ELEMENT_PADDING,
  top: ELEMENT_PADDING,
});

export const elementTrimBounds = async (
  png: Uint8Array,
  background: Rgb,
): Promise<ElementTrimBounds> => {
  const result = await sharp(png)
    .trim({ background, threshold: 5 })
    .toBuffer({ resolveWithObject: true });
  return {
    height: result.info.height,
    left: -requireValue(
      result.info.trimOffsetLeft,
      "The trimmed screenshot has no left offset.",
    ),
    top: -requireValue(
      result.info.trimOffsetTop,
      "The trimmed screenshot has no top offset.",
    ),
    width: result.info.width,
  };
};

export const cropElementLayerPng = async (
  png: Uint8Array,
  bounds: ElementTrimBounds,
  background: Rgb & { alpha?: number },
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(png)
      .extract(bounds)
      .extend(padded(background))
      .png()
      .toBuffer(),
  );

export const trimElementPng = async (
  png: Uint8Array,
  background: Rgb,
): Promise<Uint8Array> => {
  const image = sharp(png);
  const source = await image.metadata();
  requireValue(source.width, "The screenshot PNG has no width.");
  requireValue(source.height, "The screenshot PNG has no height.");
  const result = await image
    .trim({ background, threshold: 5 })
    .extend(padded(background))
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!wasImageTrimmed(source, result.info, ELEMENT_PADDING)) {
    throw new Error("The selected screenshot element has no visible content.");
  }
  return new Uint8Array(result.data);
};
