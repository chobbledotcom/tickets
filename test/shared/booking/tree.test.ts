import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type BuildTreeInput, buildBookingTree } from "#booking/build-tree.ts";
import { buildTicketListing } from "#booking/model.ts";
import {
  type BookingNode,
  childNodeKey,
  childPriceFieldName,
  childQuantityFieldName,
  customPriceFieldName,
  groupMemberNodeKey,
  listingNodeKey,
  nodePriceFieldName,
  nodeQuantityFieldName,
  packageMemberNodeKey,
  packageQuantityFieldName,
  quantityFieldName,
} from "#booking/tree.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { treePackage as pkg } from "#test-utils/package-cap-fixtures.ts";

const resolved = (overrides = {}, closed = false, groupRemaining?: number) =>
  buildTicketListing(testListingWithCount(overrides), closed, groupRemaining);

describe("booking tree — node identity (nodeKey scheme)", () => {
  test("addresses each path distinctly so the same listing never collapses", () => {
    // The single listing id 7 reached four ways must yield four distinct keys.
    expect(listingNodeKey(7)).toBe("listing:7");
    expect(groupMemberNodeKey(3, 7)).toBe("group:3/member:7");
    expect(packageMemberNodeKey(3, 7)).toBe("package:3/member:7");
    expect(childNodeKey(listingNodeKey(5), 7)).toBe("listing:5/child:7");
    const keys = new Set([
      listingNodeKey(7),
      groupMemberNodeKey(3, 7),
      packageMemberNodeKey(3, 7),
      childNodeKey(listingNodeKey(5), 7),
    ]);
    expect(keys.size).toBe(4);
  });

  test("the same child under two parents is two distinct nodes", () => {
    expect(childNodeKey(listingNodeKey(1), 9)).not.toBe(
      childNodeKey(listingNodeKey(2), 9),
    );
  });

  test("the same child under a standalone vs a package parent stays distinct", () => {
    // Parent listing 5 reached standalone vs as package group 3's member: its
    // required child 9 must NOT collapse to one signed identity, because the
    // package path carries different provenance (group id, hidden projection,
    // package-scaled quantity) that the signature layer revalidates by nodeKey.
    expect(childNodeKey(listingNodeKey(5), 9)).not.toBe(
      childNodeKey(packageMemberNodeKey(3, 5), 9),
    );
  });
});

describe("booking tree — form field-name SSOT", () => {
  test("matches the exact names render emits and submit parses", () => {
    expect(quantityFieldName(4)).toBe("quantity_4");
    expect(customPriceFieldName(4)).toBe("custom_price_4");
    expect(childQuantityFieldName(2, 9)).toBe("child_qty_2_9");
    expect(childPriceFieldName(2, 9)).toBe("child_price_2_9");
    // Per group, so a page selling several bundles posts one count each.
    expect(packageQuantityFieldName(3)).toBe("package_quantity_3");
    expect(packageQuantityFieldName(8)).not.toBe(packageQuantityFieldName(3));
  });

  test("child field names embed both the parent and child id", () => {
    // The parent id precedes the child id, so a child under two parents differs.
    expect(childQuantityFieldName(2, 9)).toBe("child_qty_2_9");
    expect(childQuantityFieldName(3, 9)).not.toBe(childQuantityFieldName(2, 9));
    expect(childPriceFieldName(2, 9)).toBe("child_price_2_9");
    expect(childPriceFieldName(3, 9)).not.toBe(childPriceFieldName(2, 9));
  });
});

/** A minimal helper to fetch a node's projected quantity field name. */
const qtyField = (node: BookingNode) => nodeQuantityFieldName(node);

describe("booking tree — nodeKey → field-name projection", () => {
  test("standalone / regular-group / parent nodes post quantity_<id>", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 4, slug: "ab12c" })],
      slugs: ["ab12c"],
    });
    expect(qtyField(tree.nodes[0]!)).toBe("quantity_4");
  });

  test("a required child posts child_qty_<parentId>_<childId>", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([[4, [resolved({ id: 9, slug: "chld1" })]]]),
      listings: [resolved({ id: 4, slug: "ab12c" })],
      slugs: ["ab12c"],
    });
    const child = tree.nodes[0]!.children[0]!;
    expect(qtyField(child)).toBe("child_qty_4_9");
  });

  test("a package member has no per-member quantity field (uses its package's count)", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7, slug: "ab12c" })],
      packages: [pkg(3, [7], { quantities: new Map([[7, 2]]) })],
      slugs: ["ab12c"],
    });
    expect(qtyField(tree.nodes[0]!)).toBeNull();
  });

  test("a regular (non-package) group member DOES post quantity_<id>", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7, slug: "ab12c" })],
      root: { groupId: 3, kind: "group" },
      slugs: ["ab12c"],
    });
    expect(qtyField(tree.nodes[0]!)).toBe("quantity_7");
  });

  test("pay-more price field mirrors the node's edge", () => {
    const standalone = buildBookingTree({
      listings: [resolved({ can_pay_more: true, id: 4, max_price: 5000 })],
      slugs: ["ab12c"],
    });
    expect(nodePriceFieldName(standalone.nodes[0]!)).toBe("custom_price_4");

    const withChild = buildBookingTree({
      childrenByParentId: new Map([
        [4, [resolved({ can_pay_more: true, id: 9, max_price: 5000 })]],
      ]),
      listings: [resolved({ id: 4 })],
      slugs: ["ab12c"],
    });
    expect(nodePriceFieldName(withChild.nodes[0]!.children[0]!)).toBe(
      "child_price_4_9",
    );
  });

  test("a non-pay-more node has no price field", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 4 })],
      slugs: ["ab12c"],
    });
    expect(nodePriceFieldName(tree.nodes[0]!)).toBeNull();
  });
});

describe("buildBookingTree — root identity", () => {
  test("a single slug is a listing root carrying its slug list", () => {
    const tree = buildBookingTree({
      listings: [resolved({ slug: "ab12c" })],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ kind: "listing", slugs: ["ab12c"] });
  });

  test("multiple slugs are one listing root (the ad-hoc cart)", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({ id: 1, slug: "ab12c" }),
        resolved({ id: 2, slug: "cd34e" }),
      ],
      slugs: ["ab12c", "cd34e"],
    });
    expect(tree.rootRef).toEqual({
      kind: "listing",
      slugs: ["ab12c", "cd34e"],
    });
    expect(tree.nodes.map((n) => n.listingId)).toEqual([1, 2]);
  });

  test("a group root carries its group id", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 })],
      root: { groupId: 3, kind: "group" },
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 3, kind: "group" });
  });

  test("a page that IS one package carries a package root", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 })],
      packages: [pkg(3, [7])],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 3, kind: "package" });
  });

  test("a cart mixing a package with other listings is a listing root", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 }), resolved({ id: 8 })],
      packages: [pkg(3, [7])],
      slugs: ["pkg-3", "ab12c"],
    });
    expect(tree.rootRef).toEqual({
      kind: "listing",
      slugs: ["pkg-3", "ab12c"],
    });
  });

  test("a cart of two packages is a listing root (no single package identity)", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 }), resolved({ id: 8 })],
      packages: [pkg(3, [7]), pkg(4, [8])],
      slugs: ["a", "b"],
    });
    expect(tree.rootRef).toEqual({ kind: "listing", slugs: ["a", "b"] });
  });
});

describe("buildBookingTree — node facets", () => {
  test("a standalone node: none edge, buyer-choice qty, own key, shown, no date", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 4, slug: "ab12c" })],
      slugs: ["ab12c"],
    });
    const node = tree.nodes[0]!;
    expect(node.nodeKey).toBe("listing:4");
    expect(node.edgeRef).toEqual({ kind: "none" });
    expect(node.quantityRule).toEqual({ kind: "BUYER_CHOICE" });
    expect(node.visibility).toBe("SHOWN");
    expect(node.dateSpan).toEqual({ kind: "NONE" });
    expect(node.children).toEqual([]);
  });

  test("a regular-group member carries its group_member edge and key", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 })],
      root: { groupId: 3, kind: "group" },
      slugs: ["ab12c"],
    });
    const node = tree.nodes[0]!;
    expect(node.nodeKey).toBe("group:3/member:7");
    expect(node.edgeRef).toEqual({ groupId: 3, kind: "group_member" });
  });

  test("a parent node nests its required children as parent_child nodes", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([
        [4, [resolved({ id: 9 }), resolved({ id: 10 })]],
      ]),
      listings: [resolved({ id: 4 })],
      slugs: ["ab12c"],
    });
    const [child1, child2] = tree.nodes[0]!.children;
    expect(child1!.nodeKey).toBe("listing:4/child:9");
    expect(child1!.edgeRef).toEqual({ kind: "parent_child", parentId: 4 });
    // A shown standalone parent does not hide its (non-hidden) children.
    expect(child1!.visibility).toBe("SHOWN");
    expect(child2!.nodeKey).toBe("listing:4/child:10");
  });

  test("only a daily/customisable child inherits a span; a standard child is date-less", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([
        [
          4,
          [
            resolved({ id: 9 }), // standard → date-less
            resolved({ id: 10, listing_type: "daily" }), // daily → inherits
            resolved({ customisable_days: true, id: 11 }), // customisable → inherits
          ],
        ],
      ]),
      listings: [resolved({ id: 4 })],
      slugs: ["ab12c"],
    });
    const [standard, daily, customisable] = tree.nodes[0]!.children;
    expect(standard!.dateSpan).toEqual({ kind: "NONE" });
    expect(daily!.dateSpan).toEqual({ kind: "INHERIT" });
    expect(customisable!.dateSpan).toEqual({ kind: "INHERIT" });
  });

  test("a hidden child is a HIDDEN node (kept, never named)", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([[4, [resolved({ hidden: true, id: 9 })]]]),
      listings: [resolved({ id: 4 })],
      slugs: ["ab12c"],
    });
    expect(tree.nodes[0]!.children[0]!.visibility).toBe("HIDDEN");
  });
});

describe("buildBookingTree — price rule precedence", () => {
  const priceOf = (input: BuildTreeInput) =>
    buildBookingTree(input).nodes[0]!.priceRule;

  test("OVERRIDE beats pay-more and day-price for a package member", () => {
    expect(
      priceOf({
        listings: [resolved({ can_pay_more: true, id: 7, max_price: 9000 })],
        packages: [pkg(3, [7], { prices: new Map([[7, 500]]) })],
        slugs: ["x"],
      }),
    ).toEqual({ amountMinor: 500, kind: "OVERRIDE" });
  });

  test("PAY_MORE beats day-price and base", () => {
    expect(
      priceOf({
        listings: [
          resolved({
            can_pay_more: true,
            customisable_days: true,
            id: 7,
            max_price: 9000,
            unit_price: 1000,
          }),
        ],
        slugs: ["x"],
      }),
    ).toEqual({ kind: "PAY_MORE", maxMinor: 9000, minMinor: 1000 });
  });

  test("DAY_PRICE only for a customisable listing without pay-more", () => {
    expect(
      priceOf({
        listings: [resolved({ customisable_days: true, id: 7 })],
        slugs: ["x"],
      }),
    ).toEqual({ kind: "DAY_PRICE" });
  });

  test("BASE for a fixed daily listing (charged at its unit price, not day-priced)", () => {
    // A daily listing that is not `customisable_days` charges `unit_price`; the
    // date only drives availability, so it must not be day-priced.
    expect(
      priceOf({
        listings: [resolved({ id: 7, listing_type: "daily" })],
        slugs: ["x"],
      }),
    ).toEqual({ kind: "BASE" });
  });

  test("BASE for a plain standard listing", () => {
    expect(priceOf({ listings: [resolved({ id: 7 })], slugs: ["x"] })).toEqual({
      kind: "BASE",
    });
  });
});
