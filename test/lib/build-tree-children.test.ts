import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuildTreeInput } from "#shared/booking/build-tree.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { resolved } from "./booking-model-fixtures.ts";
import { treePackage } from "./package-cap-fixtures.ts";

/** A parent (id 1) with one required child (id 9), for tests that only need
 * to vary the child's own listing fields or the surrounding tree input. */
const treeWithChild = (
  childOverrides: Partial<ListingWithCount> = {},
  treeOverrides: Partial<BuildTreeInput> = {},
) =>
  buildBookingTree({
    childrenByParentId: new Map([
      [1, [resolved({ id: 9, ...childOverrides })]],
    ]),
    listings: [resolved({ id: 1 })],
    slugs: ["ab12c"],
    ...treeOverrides,
  });

describe("buildBookingTree — price rule", () => {
  test("a standard listing uses BASE by default", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({ can_pay_more: false, customisable_days: false, id: 1 }),
      ],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.priceRule).toEqual({ kind: "BASE" });
  });

  test("a pay-what-you-want listing uses PAY_MORE with its min/max", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          can_pay_more: true,
          id: 1,
          max_price: 5000,
          unit_price: 1000,
        }),
      ],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.priceRule).toEqual({
      kind: "PAY_MORE",
      maxMinor: 5000,
      minMinor: 1000,
    });
  });

  test("a customisable listing uses DAY_PRICE with no overrides outside a package", () => {
    const tree = buildBookingTree({
      listings: [resolved({ customisable_days: true, id: 1 })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.priceRule).toEqual({
      kind: "DAY_PRICE",
      overrides: undefined,
    });
  });

  test("a package member's flat price override wins over pay-what-you-want", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          can_pay_more: true,
          id: 1,
          max_price: 5000,
          unit_price: 1000,
        }),
      ],
      packages: [treePackage(3, [1], { prices: new Map([[1, 2500]]) })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.priceRule).toEqual({
      amountMinor: 2500,
      kind: "OVERRIDE",
    });
  });

  test("a package member's per-day overrides ride the DAY_PRICE rule", () => {
    const dayOverrides = new Map([[3, 900]]);
    const tree = buildBookingTree({
      listings: [resolved({ customisable_days: true, id: 1 })],
      packages: [
        treePackage(3, [1], { dayPrices: new Map([[1, dayOverrides]]) }),
      ],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.priceRule).toEqual({
      kind: "DAY_PRICE",
      overrides: dayOverrides,
    });
  });
});

describe("buildBookingTree — child date span", () => {
  test("a daily child inherits the parent's span", () => {
    const tree = treeWithChild({ listing_type: "daily" });
    expect(tree.nodes[0]!.children[0]!.dateSpan).toEqual({ kind: "INHERIT" });
  });

  test("a customisable-days child inherits the parent's span", () => {
    const tree = treeWithChild({ customisable_days: true });
    expect(tree.nodes[0]!.children[0]!.dateSpan).toEqual({ kind: "INHERIT" });
  });

  test("a standard (non-daily, non-customisable) child has no date span", () => {
    const tree = treeWithChild({
      customisable_days: false,
      listing_type: "standard",
    });
    expect(tree.nodes[0]!.children[0]!.dateSpan).toEqual({ kind: "NONE" });
  });
});

describe("buildBookingTree — child nodes", () => {
  test("builds a child node addressed by the parent's full nodeKey", () => {
    const tree = treeWithChild();
    const childNode = tree.nodes[0]!.children[0]!;
    expect(childNode.nodeKey).toBe("listing:1/child:9");
    expect(childNode.edgeRef).toEqual({ kind: "parent_child", parentId: 1 });
    expect(childNode.quantityRule).toEqual({ kind: "BUYER_CHOICE" });
  });

  test("has no children when the parent has no children entry", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 1 })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.children).toEqual([]);
  });

  test("builds every child for a parent with multiple children, in order", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([
        [1, [resolved({ id: 9 }), resolved({ id: 10 })]],
      ]),
      listings: [resolved({ id: 1 })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.children.map((c) => c.listingId)).toEqual([9, 10]);
  });

  test("a package member's own children use the package-member ancestor path", () => {
    const tree = treeWithChild({}, { packages: [treePackage(3, [1])] });
    expect(tree.nodes[0]!.children[0]!.nodeKey).toBe(
      "package:3/member:1/child:9",
    );
  });

  describe("visibility", () => {
    test("a child is shown when neither it nor its parent is hidden", () => {
      const tree = treeWithChild();
      expect(tree.nodes[0]!.children[0]!.visibility).toBe("SHOWN");
    });

    test("a child is hidden when its own listing is hidden", () => {
      const tree = treeWithChild({ hidden: true });
      expect(tree.nodes[0]!.children[0]!.visibility).toBe("HIDDEN");
    });

    test("a child is hidden when its hidden package-member parent is hidden, even if the child itself isn't", () => {
      const tree = treeWithChild(
        {},
        { packages: [treePackage(3, [1], { hideListings: true })] },
      );
      expect(tree.nodes[0]!.children[0]!.visibility).toBe("HIDDEN");
    });
  });
});
