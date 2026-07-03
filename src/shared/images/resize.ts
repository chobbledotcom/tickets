/**
 * Pure image downscaling — no imports, no IO, trivially unit-testable.
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

import type { RawImage } from "./types.ts";

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
  const { data, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const scaleX = sw / dstW;
  const scaleY = sh / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const y0 = dy * scaleY;
    const y1 = (dy + 1) * scaleY;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = dx * scaleX;
      const x1 = (dx + 1) * scaleX;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));

      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      let accW = 0;
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const w = wx * wy;
          const o = (sy * sw + sx) * 4;
          // In-bounds by construction (o derived from valid sx/sy), so the
          // non-null assertions never fire — avoiding a `?? 0` fallback that
          // would be an unreachable, uncovered branch.
          const a = data[o + 3]!;
          const af = (a / 255) * w;
          accR += data[o]! * af;
          accG += data[o + 1]! * af;
          accB += data[o + 2]! * af;
          accA += a * w;
          accW += w;
        }
      }

      const o = (dy * dstW + dx) * 4;
      const avgA = accA / accW;
      const af = avgA / 255;
      if (af > 0) {
        out[o] = Math.round(accR / accW / af);
        out[o + 1] = Math.round(accG / accW / af);
        out[o + 2] = Math.round(accB / accW / af);
      }
      out[o + 3] = Math.round(avgA);
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
