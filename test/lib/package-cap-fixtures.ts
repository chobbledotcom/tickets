import { buildBookingTree } from "#shared/booking/build-tree.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import type { TreePackage } from "#shared/booking/page-packages.ts";
import type { BookingTree } from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { resolved } from "./booking-model-fixtures.ts";

/** Shared fixtures for the package-cap*.test.ts suite. Not itself a test file. */

/** A resolved listing carrying only the ticket limit this test needs. */
export const tl = (
  id: number,
  maxPurchasable: number,
  over: Partial<ListingWithCount> = {},
): TicketListing => ({
  ...resolved({ id, ...over }),
  maxPurchasable,
});

/** One package bundle for tree inputs, defaulting every map empty. */
export const treePackage = (
  groupId: number,
  memberListingIds: number[],
  overrides: Partial<TreePackage> = {},
): TreePackage => ({
  dayPrices: new Map(),
  groupId,
  hideListings: false,
  memberListingIds,
  prices: new Map(),
  quantities: new Map(),
  ...overrides,
});

/** A package tree over the given member ids, each with its per-package qty. */
export const packageTree = (
  qtyById: ReadonlyMap<number, number>,
  groupId = 5,
): BookingTree =>
  buildBookingTree({
    listings: [...qtyById.keys()].map((id) => tl(id, 0)),
    packages: [
      treePackage(groupId, [...qtyById.keys()], { quantities: qtyById }),
    ],
    slugs: ["pkg"],
  });
