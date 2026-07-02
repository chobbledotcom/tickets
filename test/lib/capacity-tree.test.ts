import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { packageQuantityCap } from "#shared/booking/capacity-tree.ts";
import type { BookingNode, BookingTree } from "#shared/booking/tree.ts";
import type { TicketListing } from "#templates/public.tsx";
import { buildTicketListing } from "#templates/public.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

/** A resolved package-member line for buildBookingTree inputs. */
const resolved = (id: number): TicketListing =>
  buildTicketListing(testListingWithCount({ id }), false, undefined);

/** A resolved listing carrying only the `maxPurchasable` the cap reads. */
const tl = (id: number, maxPurchasable: number): TicketListing => ({
  ...buildTicketListing(testListingWithCount({ id }), false, undefined),
  maxPurchasable,
});

/** A package tree over the given member ids, each with its per-package qty. */
const packageTree = (
  qtyById: ReadonlyMap<number, number>,
  groupId = 5,
): BookingTree =>
  buildBookingTree({
    groupId,
    isPackage: true,
    listings: [...qtyById.keys()].map(resolved),
    packageQuantities: qtyById,
    slugs: ["pkg"],
  });

describe("packageQuantityCap", () => {
  test("with no capped groups the tightest own cap wins", () => {
    // floor(10/1)=10 and floor(6/2)=3 → 3 whole bundles fit.
    const tree = packageTree(
      new Map([
        [1, 1],
        [2, 2],
      ]),
    );
    const listingById = new Map([
      [1, tl(1, 10)],
      [2, tl(2, 6)],
    ]);
    expect(packageQuantityCap(tree, listingById, new Map(), new Map())).toBe(3);
  });

  test("a shared capped group can bound below the own caps", () => {
    // Both members sit in group 9 with 5 remaining; combined per-package demand
    // is 2+1=3, so groupPoolUnits(5,3)=1 — tighter than the own caps (100).
    const tree = packageTree(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );
    const listingById = new Map([
      [1, tl(1, 100)],
      [2, tl(2, 100)],
    ]);
    const groupIdsByListingId = new Map([
      [1, [9]],
      [2, [9]],
    ]);
    expect(
      packageQuantityCap(
        tree,
        listingById,
        new Map([[9, 5]]),
        groupIdsByListingId,
      ),
    ).toBe(1);
  });

  test("an uncapped group a member sits in is ignored", () => {
    // Group 9 is capped (remaining 4, demand 1 → 4); group 8 is absent from the
    // remaining map (uncapped) so it never bounds the cap. Own caps are larger.
    const tree = packageTree(new Map([[1, 1]]));
    const listingById = new Map([[1, tl(1, 50)]]);
    const groupIdsByListingId = new Map([[1, [8, 9]]]);
    expect(
      packageQuantityCap(
        tree,
        listingById,
        new Map([[9, 4]]),
        groupIdsByListingId,
      ),
    ).toBe(4);
  });

  test("the tightest of several capped groups wins", () => {
    const tree = packageTree(
      new Map([
        [1, 1],
        [2, 1],
      ]),
    );
    const listingById = new Map([
      [1, tl(1, 100)],
      [2, tl(2, 100)],
    ]);
    // Group 7: only member 1 (demand 1, remaining 6 → 6).
    // Group 9: both members (demand 2, remaining 5 → 2). The 2 wins.
    const groupIdsByListingId = new Map([
      [1, [7, 9]],
      [2, [9]],
    ]);
    expect(
      packageQuantityCap(
        tree,
        listingById,
        new Map([
          [7, 6],
          [9, 5],
        ]),
        groupIdsByListingId,
      ),
    ).toBe(2);
  });

  test("a sold-out member yields no whole bundle", () => {
    const tree = packageTree(
      new Map([
        [1, 1],
        [2, 1],
      ]),
    );
    const listingById = new Map([
      [1, tl(1, 0)],
      [2, tl(2, 5)],
    ]);
    expect(packageQuantityCap(tree, listingById, new Map(), new Map())).toBe(0);
  });

  test("a non-FIXED member counts as one unit per package", () => {
    // packageQuantityCap only ever sees FIXED package members in production; the
    // `: 1` fallback guards a defensive default. A hand-built tree with a
    // BUYER_CHOICE node exercises it: demand 1 against group 9 (remaining 3 → 3).
    const node: BookingNode = {
      children: [],
      dateSpan: { kind: "NONE" },
      edgeRef: { groupId: 5, kind: "group_member" },
      listing: testListingWithCount({ id: 1 }),
      listingId: 1,
      nodeKey: "group:5/member:1",
      priceRule: { kind: "BASE" },
      quantityRule: { kind: "BUYER_CHOICE" },
      visibility: "SHOWN",
    };
    const tree: BookingTree = {
      entry: {},
      nodes: [node],
      rootRef: { groupId: 5, kind: "package" },
    };
    expect(
      packageQuantityCap(
        tree,
        new Map([[1, tl(1, 100)]]),
        new Map([[9, 3]]),
        new Map([[1, [9]]]),
      ),
    ).toBe(3);
  });
});
