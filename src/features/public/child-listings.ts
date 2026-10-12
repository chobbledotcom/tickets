/** The child listings a parent set loads and projects: the parent→children
 * map the booking pages, the fold, and the order gallery share. */

import type { TicketListing } from "#booking/model.ts";
import { hydrateListingLinks, listingChildren } from "#db/listing-parents.ts";
import { requiredMapValue, unique, uniqueBy } from "#fp";
import type { ListingWithCount } from "#types";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type { ChildrenByParentId } from "./types.ts";

/**
 * Children are loaded by relationship only. Bookability is evaluated at render
 * and submit against the resolved date.
 *
 * Keeping the date-less group cap off a daily parent's children needs no code
 * here. That aggregate already excludes every daily listing, and a daily
 * parent's group is type-homogeneous, so any child co-grouped with it is daily
 * too. Per-date capacity is left to the date-aware checkAvailability, which
 * rejects and never clamps.
 */
export const loadChildrenByParentId = async (
  listings: TicketListing[],
): Promise<ChildrenByParentId> => {
  const childLinks = await hydrateListingLinks(
    listingChildren,
    listings.map((e) => e.listing.id),
  );
  const childrenByParent = childLinks.listingsByKey;
  // One hydration for every parent's children. A per-parent call re-reads a
  // shared capped group's remaining once per parent and trips the N+1 guard
  // on a parent-rich catalog.
  const hydrated = await buildTicketListingsWithGroupCapacity(
    uniqueBy((child: ListingWithCount) => child.id)(
      [...childrenByParent.values()].flat(),
    ),
  );
  const hydratedById = new Map(hydrated.map((info) => [info.listing.id, info]));
  return mappedChildrenByParentId(childrenByParent, (parentId, child) =>
    requiredMapValue(
      hydratedById,
      child.id,
      `Child ${child.id} of listing ${parentId} left the catalog`,
    ),
  );
};

/** Each parent's children mapped through `toChild`, keyed as before. */
export const mappedChildrenByParentId = <Child, Mapped>(
  childrenByParent: ReadonlyMap<number, readonly Child[]>,
  toChild: (parentId: number, child: Child) => Mapped,
): Map<number, Mapped[]> =>
  new Map(
    [...childrenByParent].map(([parentId, children]) => [
      parentId,
      children.map((child) => toChild(parentId, child)),
    ]),
  );

/** Every parent's children flattened to their listings, in parent order. */
export const allChildListings = (
  childrenByParentId: ChildrenByParentId,
): ListingWithCount[] =>
  [...childrenByParentId.values()].flat().map((child) => child.listing);

/** Distinct child listing ids across every parent's children. */
export const childListingIdsOf = (
  childrenByParentId: ChildrenByParentId,
): number[] =>
  unique(allChildListings(childrenByParentId).map((listing) => listing.id));
