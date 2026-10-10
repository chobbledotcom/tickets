import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { TicketListing } from "#booking/model.ts";
import { packageLimitInfo } from "#booking/package-cap.ts";
import {
  buildPageTree,
  packagePageAvailability,
} from "#templates/public/reservations/availability.ts";
import { resolved } from "#test-utils/booking-model-fixtures.ts";
import { tl } from "#test-utils/package-cap-fixtures.ts";

/** A parent that sells at least `minimum` per purchase with `remaining`
 *  spots, standing alone on the page. */
const parent = (minimum: number, remaining = 10): TicketListing =>
  resolved({
    attendee_count: 10 - remaining,
    id: 1,
    max_attendees: 10,
    max_quantity: 10,
    min_quantity: minimum,
    name: "Parent",
    slug: "parent",
  });

const pageOf = (
  listings: TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]> | undefined,
  groupRemainingByGroupId: ReadonlyMap<number, number> = new Map(),
  groupIdsByListingId: ReadonlyMap<number, number[]> = new Map(),
) => {
  const { tree } = buildPageTree(
    {
      listings,
      packages: [],
      slugs: listings.map((info) => info.listing.slug),
    },
    0,
  );
  return packagePageAvailability(
    [],
    tree,
    listings,
    new Set(listings.map((info) => info.listing.id)),
    packageLimitInfo(
      listings,
      childrenByParentId,
      groupRemainingByGroupId,
      groupIdsByListingId,
    ),
  );
};

describe("packagePageAvailability — the minimum and the children", () => {
  test("a parent whose children cannot serve its minimum reads sold out", () => {
    // The children serve two parent tickets; the parent sells at least
    // three, so no quantity can book and the whole page reads sold out.
    const info = parent(3);
    const result = pageOf([info], new Map([[1, [tl(2, 2)]]]));
    expect(result.soldOut).toBe(true);
  });

  test("a parent whose children serve its minimum stays bookable", () => {
    const info = parent(3);
    const result = pageOf([info], new Map([[1, [tl(2, 5)]]]));
    expect(result.soldOut).toBe(false);
  });

  test("a childless listing reads its own remaining against the minimum", () => {
    const soldOut = parent(3, 2);
    const result = pageOf([soldOut], new Map());
    expect(result.soldOut).toBe(true);
  });

  test("a page with no children map at all reads each listing alone", () => {
    const info = parent(3);
    const result = pageOf([info], undefined);
    expect(result.soldOut).toBe(false);
  });

  test("split-pool children that combine to the minimum keep the page bookable", () => {
    // The parent sits in two pools with 6 and 4 places left. One child draws
    // only the 6-place pool, the other draws both. A quantity-3 purchase
    // splits 2+1 across the children, so the page stays bookable; a
    // per-pool bound answers 2 and reads the page sold out.
    const result = pageOf(
      [parent(3)],
      new Map([[1, [tl(2, 2), tl(3, 2)]]]),
      new Map([
        [1, 6],
        [2, 4],
      ]),
      new Map([
        [1, [1, 2]],
        [2, [1]],
        [3, [1, 2]],
      ]),
    );
    expect(result.soldOut).toBe(false);
  });
});
