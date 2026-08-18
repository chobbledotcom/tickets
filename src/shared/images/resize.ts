/**
 * Pure image downscaling — no IO, trivially unit-testable.
 *
 * The pipeline only ever shrinks images (each variant caps the width), so the
 * right filter is an *area average*: every destination pixel is the
 * alpha-weighted mean of the source pixels its footprint covers, with
 * fractional weights at the edges of that footprint. This antialiases cleanly
 * on large reductions where a bilinear sample would drop detail and shimmer.
 *
 * Colours are averaged premultiplied by alpha, then un-premultiplied, so a
 * transparent pixel's (arbitrary) colour never bleeds into its neighbours.
 * Fully-opaque images — the common case — reduce to a plain per-channel mean.
 */

import { range } from "#fp";
import type { RawImage } from "./types.ts";

type RgbaPixel = [number, number, number, number];

/** Calculate one destination pixel from its exact source footprint. */
const areaAveragePixel = (
  src: RawImage,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): RgbaPixel => {
  const { data, height, width } = src;
  const ix0 = Math.floor(x0);
  const ix1 = Math.min(width, Math.ceil(x1));
  const iy0 = Math.floor(y0);
  const iy1 = Math.min(height, Math.ceil(y1));
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let accA = 0;
  let accW = 0;
  for (const sy of range(iy0, iy1)) {
    const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
    for (const sx of range(ix0, ix1)) {
      const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
      const weight = wx * wy;
      const offset = (sy * width + sx) * 4;
      // In-bounds by construction (offset derived from valid sx/sy), so the
      // non-null assertions never hide a missing source channel.
      const alpha = data[offset + 3]!;
      const alphaWeight = (alpha / 255) * weight;
      accR += data[offset]! * alphaWeight;
      accG += data[offset + 1]! * alphaWeight;
      accB += data[offset + 2]! * alphaWeight;
      accA += alpha * weight;
      accW += weight;
    }
  }

  const averageAlpha = accA / accW;
  const alphaFraction = averageAlpha / 255;
  const pixel: RgbaPixel = [0, 0, 0, Math.round(averageAlpha)];
  if (alphaFraction > 0) {
    pixel[0] = Math.round(accR / accW / alphaFraction);
    pixel[1] = Math.round(accG / accW / alphaFraction);
    pixel[2] = Math.round(accB / accW / alphaFraction);
  }
  return pixel;
};

/**
 * Downscale `src` to exactly `dstW`×`dstH` using an area-average filter.
 * Requires a reduction (`dstW <= src.width`, `dstH <= src.height`) — the only
 * mode the pipeline uses. Under that contract every source pixel in the scanned
 * `[ix0,ix1)`×`[iy0,iy1)` footprint genuinely overlaps the destination cell, so
 * the per-pixel weight is always positive and the accumulated weight non-zero;
 * no zero-overlap guard is needed.
 */
export const resizeAreaAverage = (
  src: RawImage,
  dstW: number,
  dstH: number,
): RawImage => {
  const { width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = sw / dstW;
  const scaleY = sh / dstH;

  for (const dy of range(0, dstH)) {
    const y0 = dy * scaleY;
    const y1 = (dy + 1) * scaleY;
    for (const dx of range(0, dstW)) {
      const x0 = dx * scaleX;
      const x1 = (dx + 1) * scaleX;
      out.set(areaAveragePixel(src, x0, x1, y0, y1), (dy * dstW + dx) * 4);
    }
  }

  return { data: out, height: dstH, width: dstW };
};

/**
 * Cap an image's width at `maxWidth`, preserving aspect ratio. Images already
 * within the cap are returned unchanged (never upscaled); wider images are
 * area-averaged down, with the height scaled proportionally (floored at 1px).
 */
export const resizeToMaxWidth = (
  image: RawImage,
  maxWidth: number,
): RawImage => {
  if (image.width <= maxWidth) return image;
  const dstH = Math.max(1, Math.round((image.height * maxWidth) / image.width));
  return resizeAreaAverage(image, maxWidth, dstH);
};
