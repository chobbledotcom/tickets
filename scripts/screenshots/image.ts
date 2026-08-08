import { Buffer } from "node:buffer";
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

interface ScreenshotLayers {
  background: Uint8Array;
  controls: Uint8Array;
  text: Uint8Array;
}

interface ImageSize {
  height: number;
  width: number;
}

const imageSize = async (
  image: ReturnType<typeof sharp>,
): Promise<ImageSize> => {
  const metadata = await image.metadata();
  return {
    height: requireValue(metadata.height, "The screenshot PNG has no height."),
    width: requireValue(metadata.width, "The screenshot PNG has no width."),
  };
};

const padded = (
  background: Rgb & { alpha?: number },
  padding = ELEMENT_PADDING,
) => ({
  background,
  bottom: padding,
  left: padding,
  right: padding,
  top: padding,
});

const trimScreenshot = async (
  png: Uint8Array,
  background: Rgb,
  padding: number,
) => {
  const image = sharp(png);
  const source = await imageSize(image);
  const result = await image
    .trim({ background, threshold: 5 })
    .extend(padded(background, padding))
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!wasImageTrimmed(source, result.info, padding)) {
    throw new Error("The selected screenshot element has no visible content.");
  }
  return result;
};

export const elementTrimBounds = async (
  png: Uint8Array,
  background: Rgb,
): Promise<ElementTrimBounds> => {
  const result = await trimScreenshot(png, background, 0);
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

export const compositeScreenshotLayers = async (
  layers: ScreenshotLayers,
): Promise<Uint8Array> =>
  new Uint8Array(
    await sharp(layers.background)
      .composite([
        { input: Buffer.from(layers.controls) },
        { input: Buffer.from(layers.text) },
      ])
      .png()
      .toBuffer(),
  );

export const trimElementPng = async (
  png: Uint8Array,
  background: Rgb,
): Promise<Uint8Array> => {
  const result = await trimScreenshot(png, background, ELEMENT_PADDING);
  return new Uint8Array(result.data);
};
