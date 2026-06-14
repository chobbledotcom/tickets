/**
 * QR code SVG generation utility
 * Uses uqr (zero-dep, ESM, ~4KB)
 */

import { renderSVG } from "uqr";
import { getQuestionsForListing } from "#shared/db/questions.ts";
import { parseListingFields } from "#shared/listing-fields.ts";
import type { ListingWithCount } from "#shared/types.ts";

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): string =>
  renderSVG(text, { border: 1 });

/** Whether this listing can send QR code scanners directly to checkout.
 * True when no extra contact fields or questions are required. */
export const listingSupportsDirectCheckout = async (
  listing: Pick<ListingWithCount, "id" | "fields">,
): Promise<boolean> => {
  if (parseListingFields(listing.fields).length > 0) return false;
  const questions = await getQuestionsForListing(listing.id);
  return questions.length === 0;
};
