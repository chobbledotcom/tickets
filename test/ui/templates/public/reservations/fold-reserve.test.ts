/** The fold reserve: what a page parent holds back from each child's standalone
 *  row. A parent that can never fold (its minimum exceeds what its children can
 *  together serve) must reserve nothing, or its phantom demand zeroes out a
 *  `bookable_alone` child's row. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import { foldReserveByChildId } from "#templates/public/reservations/child-pricing.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const listing = (
  id: number,
  name: string,
  minQuantity: number,
  ownRemaining: number,
): TicketListing =>
  buildTicketListing(
    testListingWithCount({
      attendee_count: 0,
      id,
      max_attendees: ownRemaining,
      max_quantity: ownRemaining,
      min_quantity: minQuantity,
      name,
      slug: `s${id}`,
    }),
    false,
    undefined,
  );

const groupIds = (ids: readonly number[]): Map<number, number[]> =>
  new Map(ids.map((id) => [id, []]));

describe("foldReserveByChildId", () => {
  const page = (
    parent: TicketListing,
    children: readonly TicketListing[],
    groupMap?: ReadonlyMap<number, number[]>,
    remaining?: ReadonlyMap<number, number>,
  ): Map<number, number> =>
    foldReserveByChildId(
      [parent],
      new Map([[parent.listing.id, [...children]]]),
      groupMap ?? groupIds([parent.listing.id]),
      remaining ?? new Map(),
    );

  test("reserves nothing for a parent its children cannot serve", () => {
    // The parent sells at least 3 per purchase, but its only child can serve
    // 2: no fold through this parent can ever book, so the child's standalone
    // row keeps its whole capacity.
    const parent = listing(1, "Base unit", 3, 10);
    const child = listing(2, "Add-on", 1, 2);
    expect(page(parent, [child], groupIds([1, 2]))).toEqual(new Map([[2, 0]]));
  });

  test("holds back the parent's ceiling when it can fold", () => {
    const parent = listing(1, "Base unit", 1, 10);
    const child = listing(2, "Add-on", 1, 5);
    expect(page(parent, [child], groupIds([1, 2]))).toEqual(new Map([[2, 10]]));
  });

  test("meets the minimum through children that share one pool", () => {
    // Two children drawing pairs from a pool of four serve two parent
    // tickets together — exactly the minimum — so the parent folds and
    // reserves.
    const parent = listing(1, "Base unit", 2, 10);
    const childA = listing(2, "Left add-on", 1, 2);
    const childB = listing(3, "Right add-on", 1, 2);
    expect(
      page(
        parent,
        [childA, childB],
        new Map([
          [1, [7]],
          [2, [7]],
          [3, [7]],
        ]),
        new Map([[7, 4]]),
      ),
    ).toEqual(
      new Map([
        [2, 10],
        [3, 10],
      ]),
    );
  });
});
