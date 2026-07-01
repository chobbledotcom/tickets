import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import {
  edgeDrifted,
  lineNodeKey,
  signedEdgeFor,
  treeNodeKeys,
} from "#shared/booking/signed-metadata.ts";
import type { BookingTree } from "#shared/booking/tree.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import type { BookingItem } from "#shared/payments.ts";
import { buildTicketListing } from "#templates/public.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

const resolved = (id: number) =>
  buildTicketListing(testListingWithCount({ id }), false, undefined);

/** A package tree over member 5 with required child 9 (nodeKeys
 * `package:3/member:5` and `package:3/member:5/child:9`). */
const packageWithChild = (): BookingTree =>
  buildBookingTree({
    childrenByParentId: new Map([[5, [resolved(9)]]]),
    groupId: 3,
    isPackage: true,
    listings: [resolved(5)],
    packageQuantities: new Map([[5, 1]]),
    slugs: ["pkg"],
  });

const memberLine: BookingItem = { e: 5, k: "p", p: 100, q: 1, r: 3 };
const childLine: BookingItem = { e: 9, p: 50, q: 1 };
const childAlloc: ChildAllocation = { childId: 9, parentId: 5, qty: 1 };

describe("signedEdgeFor", () => {
  test("tags a package member's top-level line", () => {
    expect(signedEdgeFor(3, false)).toEqual({ k: "p", r: 3 });
  });
  test("leaves a folded child untagged", () => {
    expect(signedEdgeFor(3, true)).toEqual({});
  });
  test("leaves a non-package line untagged", () => {
    expect(signedEdgeFor(undefined, false)).toEqual({});
  });
});

describe("lineNodeKey", () => {
  test("a package member reconstructs its package nodeKey", () => {
    expect(lineNodeKey({ e: 5, k: "p", p: 0, q: 1, r: 3 })).toBe(
      "package:3/member:5",
    );
  });
  test("a group member reconstructs its group nodeKey", () => {
    expect(lineNodeKey({ e: 5, k: "g", p: 0, q: 1, r: 7 })).toBe(
      "group:7/member:5",
    );
  });
  test("an untagged line is a standalone listing", () => {
    expect(lineNodeKey({ e: 5, p: 0, q: 1 })).toBe("listing:5");
  });
  test("a tag missing its ref falls back to standalone", () => {
    expect(lineNodeKey({ e: 5, k: "p", p: 0, q: 1 })).toBe("listing:5");
  });
  test("a ref without a kind is a standalone listing", () => {
    expect(lineNodeKey({ e: 5, p: 0, q: 1, r: 7 })).toBe("listing:5");
  });
});

describe("treeNodeKeys", () => {
  test("collects every top-level node and descendant", () => {
    expect(treeNodeKeys(packageWithChild())).toEqual(
      new Set(["package:3/member:5", "package:3/member:5/child:9"]),
    );
  });
});

describe("edgeDrifted", () => {
  test("a fully-resolving package+child order is not drifted", () => {
    expect(
      edgeDrifted(packageWithChild(), [memberLine, childLine], [childAlloc]),
    ).toBe(false);
  });

  test("a standalone parent+child order is not drifted", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([[5, [resolved(9)]]]),
      listings: [resolved(5)],
      slugs: ["p"],
    });
    expect(
      edgeDrifted(
        tree,
        [
          { e: 5, p: 100, q: 1 },
          { e: 9, p: 50, q: 1 },
        ],
        [childAlloc],
      ),
    ).toBe(false);
  });

  test("a top-level line no longer in the tree is drifted", () => {
    // Member 5 was removed from the package mid-checkout.
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [],
      slugs: ["pkg"],
    });
    expect(edgeDrifted(tree, [memberLine], [])).toBe(true);
  });

  test("a removed child edge is drifted", () => {
    // The parent stays a member but its required-child edge was removed.
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [resolved(5)],
      packageQuantities: new Map([[5, 1]]),
      slugs: ["pkg"],
    });
    expect(edgeDrifted(tree, [memberLine, childLine], [childAlloc])).toBe(true);
  });

  test("an allocation whose parent line is absent is drifted", () => {
    // The child is folded but its parent line never appears in the items.
    expect(edgeDrifted(packageWithChild(), [childLine], [childAlloc])).toBe(
      true,
    );
  });
});
