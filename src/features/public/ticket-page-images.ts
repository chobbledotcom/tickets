/**
 * The image-url lookup a rendered ticket page's markdown needs.
 */

import { imageUrlsFor } from "#db/images.ts";

/** The pieces of a rendered ticket page whose markdown can name an image. */
export type TicketPageTexts = {
  listings: readonly { listing: { description: string | null } }[];
  groupDescription?: string;
  terms?: string | null;
  packages?: readonly { description: string }[];
};

/** The id→uid-URL table for one rendered ticket page's markdown. The texts
 * are the listing descriptions, the group description, the terms, and the
 * packages' descriptions. A render-path-only read, bounded by the ids the
 * texts reference. The submit, quote, and API flows never pay it. */
export const ticketPageImageUrls = (
  page: TicketPageTexts,
): Promise<ReadonlyMap<number, string>> =>
  imageUrlsFor([
    ...page.listings.map((entry) => entry.listing.description),
    page.groupDescription,
    page.terms,
    ...(page.packages?.map((pkg) => pkg.description) ?? []),
  ]);
