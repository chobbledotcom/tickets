import { buildBookingTree } from "#shared/booking/build-tree.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import type {
  PagePackage,
  TreePackage,
} from "#shared/booking/page-packages.ts";
import type { BookingTree } from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { resolved } from "#test/test-utils/booking-model-fixtures.ts";

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

/** One page package (bundle + display fields) with everything defaulted. */
export const pagePackage = (
  groupId: number,
  memberIds: number[],
  over: Partial<PagePackage> = {},
): PagePackage => ({
  ...treePackage(groupId, memberIds),
  description: "",
  name: `Package ${groupId}`,
  slug: `pkg${groupId}s`,
  terms: "",
  ...over,
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

/** A two-bundle cart beside a plain listing: packages 3 (member 7) and
 * 4 (member 8) with listing 9 standalone. */
export const twoPackageCart = (
  overrides3: Partial<TreePackage> = {},
  overrides4: Partial<TreePackage> = {},
): BookingTree =>
  buildBookingTree({
    listings: [resolved({ id: 7 }), resolved({ id: 8 }), resolved({ id: 9 })],
    packages: [
      treePackage(3, [7], overrides3),
      treePackage(4, [8], overrides4),
    ],
    slugs: ["a", "b", "c"],
  });
