import { buildBookingTree } from "#shared/booking/build-tree.ts";
import type { TicketListing } from "#shared/booking/model.ts";
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

/** A package tree over the given member ids, each with its per-package qty. */
export const packageTree = (
  qtyById: ReadonlyMap<number, number>,
  groupId = 5,
): BookingTree =>
  buildBookingTree({
    listings: [...qtyById.keys()].map((id) => tl(id, 0)),
    packageQuantities: qtyById,
    root: { groupId, kind: "package" },
    slugs: ["pkg"],
  });
