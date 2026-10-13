/**
 * Whether a listing's own public page serves, and which listings a page
 * keeps. The public pages, the admin QR generators, and the public API
 * share these guards.
 */

/* jscpd:ignore-start -- imports */
import type { TicketListing } from "#booking/model.ts";
import {
  anyNonStandaloneChild,
  listingChildren,
  listingParents,
} from "#db/listing-parents.ts";
import { getListingsBySlugs } from "#db/listings/records.ts";
import { compact } from "#fp";
import { notFoundResponse } from "#routes/response.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
/* jscpd:ignore-end */
import type { ListingWithCount } from "#types";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Whether a listing has no standalone public booking page because it is a
 * child that cannot be booked alone. */
export const lacksStandalonePublicPage = async (
  listingId: number,
): Promise<boolean> => await anyNonStandaloneChild([listingId]);

/** Why the listing's own public page does not serve, or that it does. The one
 * share-eligibility decision. The admin QR generators read it. So do the
 * overview's share controls, the entity page's QR tab, and the public QR
 * endpoint. A rendered link never dead-ends. */
export type ListingPublicPageState = "available" | "child" | "inactive";

/** Resolve the one share-eligibility state for a listing: `child` when it
 * cannot be booked alone, `inactive` when its page is switched off, else
 * `available`. */
export const listingPublicPageState = async (
  listing: ListingWithCount,
): Promise<ListingPublicPageState> =>
  (await lacksStandalonePublicPage(listing.id))
    ? "child"
    : listing.active
      ? "available"
      : "inactive";

/** Whether the listing's own public page serves right now. */
export const standalonePageServes = async (
  listing: ListingWithCount,
): Promise<boolean> => (await listingPublicPageState(listing)) === "available";

/**
 * Drop child listings from an indirectly-loaded listing set (group/order pages).
 * A child never renders as a standalone selectable quantity row.
 * Unlike the explicit-slug entry points — which *reject* a child slug handed
 * directly (`withActiveListings`) — an indirect page loads from group membership
 * or a saved cart. A child member is expected there: it is folded under its
 * parent's selector, not booked alone. Parents stay in the set and re-load
 * their children via `childrenByParentId`. This removes only the children's
 * own standalone rows.
 */
export const dropChildListings = async (
  listings: readonly ListingWithCount[],
): Promise<ListingWithCount[]> => {
  const parentsByChild = await listingParents.getIdsByKeys(
    listings.map((listing) => listing.id),
  );
  return listings.filter(
    (listing) => parentsByChild.get(listing.id)!.length === 0,
  );
};

/**
 * Whether `listingId` is a parent (has at least one child edge). Booking a
 * parent requires choosing one of its children. The web page enforces that
 * with a per-parent selector. The JSON API has no child-selection input. It
 * uses this check to reject a parent booking and direct the caller to the
 * web booking page.
 */
export const parentRequiresChild = async (
  listingId: number,
): Promise<boolean> => (await listingChildren.getIds(listingId)).length > 0;

/** Load active listings. Return 404 if none resolve or if a resolved listing is
 * a child that cannot be booked alone. */
export const withActiveListings = async (
  slugs: string[],
  handler: ResponseHandler<[listings: TicketListing[]]>,
): Promise<Response> => {
  const listings = await getListingsBySlugs(slugs);
  const active = compact(listings).filter((e) => e.active);
  const activeListings = await buildTicketListingsWithGroupCapacity(active);
  if (activeListings.length === 0) return notFoundResponse();
  const ids = activeListings.map((e) => e.listing.id);
  if (await anyNonStandaloneChild(ids)) return notFoundResponse();
  return handler(activeListings);
};
