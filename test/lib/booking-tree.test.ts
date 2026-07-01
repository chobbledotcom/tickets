import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
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
  PACKAGE_QUANTITY_FIELD,
  packageMemberNodeKey,
  quantityFieldName,
} from "#shared/booking/tree.ts";
import { buildTicketListing } from "#templates/public/shared.tsx";
import { testListingWithCount } from "#test-utils/factories.ts";

const resolved = (overrides = {}, closed = false, groupRemaining = undefined) =>
  buildTicketListing(testListingWithCount(overrides), closed, groupRemaining);

describe("booking tree — node identity (nodeKey scheme)", () => {
  test("addresses each path distinctly so the same listing never collapses", () => {
    // The single listing id 7 reached four ways must yield four distinct keys.
    expect(listingNodeKey(7)).toBe("listing:7");
    expect(groupMemberNodeKey(3, 7)).toBe("group:3/member:7");
    expect(packageMemberNodeKey(3, 7)).toBe("package:3/member:7");
    expect(childNodeKey(5, 7)).toBe("parent:5/child:7");
    const keys = new Set([
      listingNodeKey(7),
      groupMemberNodeKey(3, 7),
      packageMemberNodeKey(3, 7),
      childNodeKey(5, 7),
    ]);
    expect(keys.size).toBe(4);
  });

  test("the same child under two parents is two distinct nodes", () => {
    expect(childNodeKey(1, 9)).not.toBe(childNodeKey(2, 9));
  });
});

describe("booking tree — form field-name SSOT", () => {
  test("matches the exact names render emits and submit parses", () => {
    expect(quantityFieldName(4)).toBe("quantity_4");
    expect(customPriceFieldName(4)).toBe("custom_price_4");
    expect(childQuantityFieldName(2, 9)).toBe("child_qty_2_9");
    expect(childPriceFieldName(2, 9)).toBe("child_price_2_9");
    expect(PACKAGE_QUANTITY_FIELD).toBe("package_quantity");
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

  test("a package member has no per-member quantity field (uses package_quantity)", () => {
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [resolved({ id: 7, slug: "ab12c" })],
      packageQuantities: new Map([[7, 2]]),
      slugs: ["ab12c"],
    });
    expect(qtyField(tree.nodes[0]!)).toBeNull();
  });

  test("a regular (non-package) group member DOES post quantity_<id>", () => {
    const tree = buildBookingTree({
      groupId: 3,
      listings: [resolved({ id: 7, slug: "ab12c" })],
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

  test("a groupId without is_package is a group root", () => {
    const tree = buildBookingTree({
      groupId: 3,
      listings: [resolved({ id: 7 })],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 3, kind: "group" });
  });

  test("a groupId with is_package is a package root", () => {
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [resolved({ id: 7 })],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ groupId: 3, kind: "package" });
  });

  test("is_package without a groupId falls back to a listing root", () => {
    // Defensive: the package root needs a group id; absent one it is a plain
    // listing page rather than a malformed package.
    const tree = buildBookingTree({
      isPackage: true,
      listings: [resolved({ id: 7, slug: "ab12c" })],
      slugs: ["ab12c"],
    });
    expect(tree.rootRef).toEqual({ kind: "listing", slugs: ["ab12c"] });
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
      groupId: 3,
      listings: [resolved({ id: 7 })],
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
    expect(child1!.nodeKey).toBe("parent:4/child:9");
    expect(child1!.edgeRef).toEqual({ kind: "parent_child", parentId: 4 });
    expect(child1!.dateSpan).toEqual({ kind: "INHERIT" });
    expect(child2!.nodeKey).toBe("parent:4/child:10");
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

describe("buildBookingTree — package members", () => {
  test("members are FIXED at their per-package quantity, priced by override", () => {
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [
        resolved({ id: 7, slug: "tent1" }),
        resolved({ id: 8, slug: "chr12" }),
      ],
      packagePrices: new Map([[7, 1500]]),
      packageQuantities: new Map([[8, 4]]),
      slugs: ["tent1"],
    });
    const [tent, chair] = tree.nodes;
    expect(tent!.nodeKey).toBe("package:3/member:7");
    expect(tent!.quantityRule).toEqual({ kind: "FIXED", qty: 1 }); // defaults to 1
    expect(tent!.priceRule).toEqual({ amountMinor: 1500, kind: "OVERRIDE" });
    expect(chair!.quantityRule).toEqual({ kind: "FIXED", qty: 4 });
    expect(chair!.priceRule).toEqual({ kind: "BASE" });
  });

  test("hide_package_listings makes every member HIDDEN", () => {
    const tree = buildBookingTree({
      groupId: 3,
      hidePackageListings: true,
      isPackage: true,
      listings: [resolved({ id: 7 }), resolved({ id: 8 })],
      slugs: ["tent1"],
    });
    expect(tree.nodes.every((n) => n.visibility === "HIDDEN")).toBe(true);
  });

  test("shown by default when the package does not hide members", () => {
    const tree = buildBookingTree({
      groupId: 3,
      isPackage: true,
      listings: [resolved({ id: 7 })],
      slugs: ["tent1"],
    });
    expect(tree.nodes[0]!.visibility).toBe("SHOWN");
  });

  test("a package member that is a parent nests its required children", () => {
    // The doc's model: a package member-parent is "a FIXED member node that
    // itself has a child node" — the child edge must not be dropped for packages.
    const tree = buildBookingTree({
      childrenByParentId: new Map([[7, [resolved({ id: 20, slug: "kid20" })]]]),
      groupId: 3,
      isPackage: true,
      listings: [resolved({ id: 7, slug: "tent1" })],
      packageQuantities: new Map([[7, 1]]),
      slugs: ["tent1"],
    });
    const member = tree.nodes[0]!;
    expect(member.quantityRule).toEqual({ kind: "FIXED", qty: 1 });
    expect(member.children).toHaveLength(1);
    expect(member.children[0]!.nodeKey).toBe("parent:7/child:20");
    expect(member.children[0]!.edgeRef).toEqual({
      kind: "parent_child",
      parentId: 7,
    });
  });
});

describe("buildBookingTree — price rule precedence", () => {
  const priceOf = (input: BuildTreeInput) =>
    buildBookingTree(input).nodes[0]!.priceRule;

  test("OVERRIDE beats pay-more and day-price for a package member", () => {
    expect(
      priceOf({
        groupId: 3,
        isPackage: true,
        listings: [resolved({ can_pay_more: true, id: 7, max_price: 9000 })],
        packagePrices: new Map([[7, 500]]),
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

  test("DAY_PRICE for a daily/customisable listing without pay-more", () => {
    expect(
      priceOf({
        listings: [resolved({ id: 7, listing_type: "daily" })],
        slugs: ["x"],
      }),
    ).toEqual({ kind: "DAY_PRICE" });
    expect(
      priceOf({
        listings: [resolved({ customisable_days: true, id: 7 })],
        slugs: ["x"],
      }),
    ).toEqual({ kind: "DAY_PRICE" });
  });

  test("BASE for a plain standard listing", () => {
    expect(priceOf({ listings: [resolved({ id: 7 })], slugs: ["x"] })).toEqual({
      kind: "BASE",
    });
  });
});

describe("buildBookingTree — entry context", () => {
  test("passes the non-line entry context through unchanged", () => {
    const entry = {
      balanceAttendeeId: 42,
      parentThankYouUrl: "https://example.com/thanks",
      qrPriceOverrideMinor: 1234,
    };
    const tree = buildBookingTree({
      entry,
      listings: [resolved({ id: 7 })],
      slugs: ["x"],
    });
    expect(tree.entry).toEqual(entry);
  });

  test("defaults to an empty entry context when none is given", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 7 })],
      slugs: ["x"],
    });
    expect(tree.entry).toEqual({});
  });
});
