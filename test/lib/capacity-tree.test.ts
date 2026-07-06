import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { packageQuantityLimit } from "#shared/booking/capacity-tree.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import type { BookingNode, BookingTree } from "#shared/booking/tree.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** A resolved package-member line for buildBookingTree inputs. */
const resolved = (id: number): TicketListing =>
  buildTicketListing(testListingWithCount({ id }), false, undefined);

/** A resolved listing carrying only the ticket limit this test needs. */
const tl = (id: number, maxPurchasable: number): TicketListing => ({
  ...buildTicketListing(testListingWithCount({ id }), false, undefined),
  maxPurchasable,
});

/** Two package members (ids 1 and 2), each with a generous ticket limit so the
 *  group caps — not the members' own pools — decide the package limit. */
const twoMembersUncapped = (): ReadonlyMap<number, TicketListing> =>
  new Map([
    [1, tl(1, 100)],
    [2, tl(2, 100)],
  ]);

/** A package tree over the given member ids, each with its per-package qty. */
const packageTree = (
  qtyById: ReadonlyMap<number, number>,
  groupId = 5,
): BookingTree =>
  buildBookingTree({
    listings: [...qtyById.keys()].map(resolved),
    packageQuantities: qtyById,
    root: { groupId, kind: "package" },
    slugs: ["pkg"],
  });

describe("packageQuantityLimit", () => {
  test("with no limited groups the smallest member limit wins", () => {
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
    expect(
      packageQuantityLimit(tree, listingById, new Map(), new Map(), new Map()),
    ).toBe(3);
  });

  test("a shared limited group can lower the package limit", () => {
    // Both members sit in group 9 with 5 spots left. One package needs 2+1
    // tickets from that group, so only 1 whole package fits.
    const tree = packageTree(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );
    const listingById = twoMembersUncapped();
    const groupIdsByListingId = new Map([
      [1, [9]],
      [2, [9]],
    ]);
    expect(
      packageQuantityLimit(
        tree,
        listingById,
        new Map([[9, 5]]),
        groupIdsByListingId,
        new Map(),
      ),
    ).toBe(1);
  });

  test("a group with no limit does not lower the package limit", () => {
    // Group 9 has 4 spots left. Group 8 is absent from the remaining map, so it
    // does not limit the package.
    const tree = packageTree(new Map([[1, 1]]));
    const listingById = new Map([[1, tl(1, 50)]]);
    const groupIdsByListingId = new Map([[1, [8, 9]]]);
    expect(
      packageQuantityLimit(
        tree,
        listingById,
        new Map([[9, 4]]),
        groupIdsByListingId,
        new Map(),
      ),
    ).toBe(4);
  });

  test("the smallest of several group limits wins", () => {
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
    // Group 7 only needs member 1, so 6 packages fit.
    // Group 9 needs both members, so only 2 packages fit.
    const groupIdsByListingId = new Map([
      [1, [7, 9]],
      [2, [9]],
    ]);
    expect(
      packageQuantityLimit(
        tree,
        listingById,
        new Map([
          [7, 6],
          [9, 5],
        ]),
        groupIdsByListingId,
        new Map(),
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
    expect(
      packageQuantityLimit(tree, listingById, new Map(), new Map(), new Map()),
    ).toBe(0);
  });

  test("a non-FIXED member counts as one unit per package", () => {
    // packageQuantityLimit only ever sees FIXED package members in production; the
    // `: 1` fallback guards a defensive default. A hand-built tree with a
    // BUYER_CHOICE node exercises it: one package needs 1 ticket from group 9.
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
      nodes: [node],
      rootRef: { groupId: 5, kind: "package" },
    };
    expect(
      packageQuantityLimit(
        tree,
        new Map([[1, tl(1, 100)]]),
        new Map([[9, 3]]),
        new Map([[1, [9]]]),
        new Map(),
      ),
    ).toBe(3);
  });
});
