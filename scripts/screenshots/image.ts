import sharp from "sharp";
import { wasImageTrimmed } from "#scripts/screenshots/checks.ts";
import type { Rgb } from "#scripts/screenshots/color.ts";
import { requireValue } from "#shared/required-value.ts";

const ELEMENT_PADDING = 32;

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
    .extend({
      background,
      bottom: ELEMENT_PADDING,
      left: ELEMENT_PADDING,
      right: ELEMENT_PADDING,
      top: ELEMENT_PADDING,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!wasImageTrimmed(source, result.info, ELEMENT_PADDING)) {
    throw new Error("The selected screenshot element has no visible content.");
  }
  return new Uint8Array(result.data);
};
