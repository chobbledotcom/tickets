/**
 * View models for the attribute admin pages: which listings use an
 * attribute's options, and how many listings use each option.
 *
 * This module is pure — the route handlers fetch, these functions compute.
 */

import type { AttributeOption } from "#db/attributes.ts";
import type { ListingOption } from "#db/listings/table.ts";
import { flatMap } from "#fp";

/** One listing that has at least one of an attribute's options set. */
export type AttributeListingRow = ListingOption & {
  /** The option texts this listing selected, in the attribute's option order. */
  optionTexts: string[];
};

/** The listings that selected at least one of the given options, in listing id
 * order, each carrying the texts of the options it selected. Pass a single
 * option to get the listings using just that option. */
export const attributeListingRows = (
  options: AttributeOption[],
  listingIdsByOption: Map<number, number[]>,
  listings: ListingOption[],
): AttributeListingRow[] => {
  const textsByListing = new Map<number, string[]>();
  for (const option of options) {
    for (const listingId of listingIdsByOption.get(option.id) ?? []) {
      const texts = textsByListing.get(listingId) ?? [];
      texts.push(option.text);
      textsByListing.set(listingId, texts);
    }
  }
  return flatMap((listing: ListingOption) => {
    const optionTexts = textsByListing.get(listing.id);
    return optionTexts ? [{ ...listing, optionTexts }] : [];
  })(listings);
};

/** How many listings have each option set, keyed by option id. */
export const optionListingCounts = (
  listingIdsByOption: Map<number, number[]>,
): Map<number, number> =>
  new Map(
    [...listingIdsByOption].map(([optionId, ids]) => [optionId, ids.length]),
  );
