/**
 * The pipeline only ever shrinks, so the right filter is an *area average*
 * rather than a bilinear sample, which would drop detail and shimmer on a large
 * reduction.
 *
 * Colours are averaged premultiplied by alpha, then un-premultiplied, so a
 * transparent pixel's arbitrary colour never bleeds into its neighbours. A
 * fully-opaque image reduces to a plain per-channel mean.
 */

import { range } from "#fp";
import type { RawImage } from "./types.ts";

type RgbaPixel = [number, number, number, number];

/** One axis of a destination cell's source footprint: the fractional span
 * `[start, end)` the cell covers, and the whole source pixels inside it. */
interface Footprint {
  end: number;
  pixels: number[];
  start: number;
}

/** Every destination cell's source footprint along one axis, computed once so
 * the per-pixel loop never rebuilds the same pixel lists. */
const axisFootprints = (dstSize: number, srcSize: number): Footprint[] => {
  const scale = srcSize / dstSize;
  return range(0, dstSize).map((cell) => {
    const start = cell * scale;
    const end = (cell + 1) * scale;
    return {
      end,
      pixels: range(Math.floor(start), Math.min(srcSize, Math.ceil(end))),
      start,
    };
  });
};

/** Calculate one destination pixel from its exact source footprint. */
const areaAveragePixel = (
  src: RawImage,
  column: Footprint,
  row: Footprint,
): RgbaPixel => {
  const { data, width } = src;
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let accA = 0;
  let accW = 0;
  for (const sy of row.pixels) {
    const wy = Math.min(row.end, sy + 1) - Math.max(row.start, sy);
    for (const sx of column.pixels) {
      const wx = Math.min(column.end, sx + 1) - Math.max(column.start, sx);
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
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const columns = axisFootprints(dstW, src.width);
  const rows = axisFootprints(dstH, src.height);

  for (const [dy, row] of rows.entries()) {
    for (const [dx, column] of columns.entries()) {
      out.set(areaAveragePixel(src, column, row), (dy * dstW + dx) * 4);
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
