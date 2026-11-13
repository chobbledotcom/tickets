/**
 * QR code generation: SVG for a page or a file, PNG for an email body.
 * Uses uqr (zero-dep, ESM, ~4KB)
 */

import { encode, renderSVG } from "uqr";
import { getQuestionsForListing } from "#db/questions/queries.ts";
import type { RawImage } from "#shared/images/types.ts";
import { parseListingFields } from "#shared/listing-fields.ts";
import type { ListingWithCount } from "#types";

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): string =>
  renderSVG(text, { border: 1 });

/** Pixels per QR module in the PNG a message body carries. */
const QR_MODULE_SCALE = 8;
const DARK = 0;
const LIGHT = 255;

/** Mark the pixels of one dark module. */
const paintModule = (
  data: Uint8ClampedArray,
  side: number,
  x: number,
  y: number,
): void => {
  for (let dy = 0; dy < QR_MODULE_SCALE; dy++) {
    for (let dx = 0; dx < QR_MODULE_SCALE; dx++) {
      const pixel =
        ((y * QR_MODULE_SCALE + dy) * side + x * QR_MODULE_SCALE + dx) * 4;
      data[pixel] = DARK;
      data[pixel + 1] = DARK;
      data[pixel + 2] = DARK;
    }
  }
};

/** Draw each QR module as a square of pixels. */
const qrPixels = (modules: ReadonlyArray<readonly boolean[]>): RawImage => {
  const side = modules.length * QR_MODULE_SCALE;
  const data = new Uint8ClampedArray(side * side * 4).fill(LIGHT);
  for (const [y, row] of modules.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) paintModule(data, side, x, y);
    }
  }
  return { data, height: side, width: side };
};

/** Render a QR code as a PNG, for a mail reader that cannot draw SVG.
 * A static import compiles the image codecs on every page that draws a QR,
 * so the codecs load at the first PNG only. */
export const qrPng = async (text: string): Promise<Uint8Array> => {
  const { encodePng } = await import("#shared/images/codecs.ts");
  return encodePng(qrPixels(encode(text, { border: 1 }).data));
};

/** Whether this listing can send QR code scanners directly to checkout.
 * True when no extra contact fields or questions are required. */
export const listingSupportsDirectCheckout = async (
  listing: Pick<ListingWithCount, "id" | "fields">,
): Promise<boolean> => {
  if (parseListingFields(listing.fields).length > 0) return false;
  const questions = await getQuestionsForListing(listing.id);
  return questions.length === 0;
};
