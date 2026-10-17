/**
 * The image-url lookup a rendered ticket page's markdown needs.
 */

import { imageUrlsFor } from "#db/images.ts";
import type { TicketCtx } from "./types.ts";

/** The id→uid-URL table for one rendered ticket page's markdown. The texts
 * are the listing descriptions, the group description, the terms, and the
 * packages' descriptions. A render-path-only read, bounded by the ids the
 * texts reference. The submit, quote, and API flows never pay it. */
export const ticketPageImageUrls = async (
  ctx: TicketCtx,
): Promise<ReadonlyMap<number, string>> =>
  imageUrlsFor([
    ...ctx.listings.map((entry) => entry.listing.description),
    ctx.groupDescription,
    ctx.terms,
    ...(ctx.packages?.map((pkg) => pkg.description) ?? []),
  ]);
