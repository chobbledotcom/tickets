import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import {
  aggregateNodeQuantities,
  buildOrderLines,
  nodeQuantitiesFor,
} from "#shared/booking/order-lines.ts";
import { resolved } from "./booking-model-fixtures.ts";
import { treePackage } from "./package-cap-fixtures.ts";

/** A page selling listing 1 through package 7 (fixed ×2, overridden to 400)
 * AND standalone (base 500), beside plain listing 2 (base 300) — the
 * overlapping-paths shape the per-path line model exists for. */
const dualPathTree = () =>
  buildBookingTree({
    listings: [
      resolved({
        id: 1,
        name: "Bouncy Castle",
        slug: "bounc",
        unit_price: 500,
      }),
      resolved({
        id: 2,
        name: "Face Painting",
        slug: "facep",
        unit_price: 300,
      }),
    ],
    packages: [
      treePackage(7, [1], {
        prices: new Map([[1, 400]]),
        quantities: new Map([[1, 2]]),
      }),
    ],
    slugs: ["bounc", "facep"],
    standaloneListingIds: new Set([1]),
  });

describe("nodeQuantitiesFor", () => {
  test("a member node books its fixed quantity times the package count", () => {
    const quantities = nodeQuantitiesFor(
      dualPathTree(),
      new Map([
        [1, 1],
        [2, 3],
      ]),
      new Map([[7, 2]]),
    );
    expect(quantities.get("package:7/member:1")).toBe(4);
    expect(quantities.get("listing:1")).toBe(1);
    expect(quantities.get("listing:2")).toBe(3);
  });

  test("missing counts resolve to zero on both paths", () => {
    const quantities = nodeQuantitiesFor(dualPathTree(), new Map(), new Map());
    expect(quantities.get("package:7/member:1")).toBe(0);
    expect(quantities.get("listing:1")).toBe(0);
  });

  test("a regular group member reads the listing's own chosen quantity", () => {
    const tree = buildBookingTree({
      listings: [resolved({ id: 5 })],
      root: { groupId: 3, kind: "group" },
      slugs: ["ab12c"],
    });
    const quantities = nodeQuantitiesFor(tree, new Map([[5, 2]]), new Map());
    expect(quantities.get("group:3/member:5")).toBe(2);
  });
});

describe("aggregateNodeQuantities", () => {
  test("sums every path's units per listing", () => {
    const tree = dualPathTree();
    const totals = aggregateNodeQuantities(
      tree,
      nodeQuantitiesFor(
        tree,
        new Map([
          [1, 1],
          [2, 3],
        ]),
        new Map([[7, 2]]),
      ),
    );
    expect([...totals]).toEqual([
      [1, 5],
      [2, 3],
    ]);
  });

  test("omits listings whose paths total zero", () => {
    const tree = dualPathTree();
    const totals = aggregateNodeQuantities(
      tree,
      nodeQuantitiesFor(tree, new Map([[2, 3]]), new Map()),
    );
    expect([...totals]).toEqual([[2, 3]]);
  });

  test("a node missing from the quantities map counts as zero", () => {
    const totals = aggregateNodeQuantities(
      dualPathTree(),
      new Map([["listing:2", 3]]),
    );
    expect([...totals]).toEqual([[2, 3]]);
  });
});

describe("buildOrderLines", () => {
  test("books one line per path, each priced by its own rule", () => {
    const tree = dualPathTree();
    const nodeQuantities = nodeQuantitiesFor(
      tree,
      new Map([
        [1, 1],
        [2, 3],
      ]),
      new Map([[7, 2]]),
    );
    const lines = buildOrderLines(
      tree,
      nodeQuantities,
      aggregateNodeQuantities(tree, nodeQuantities),
      new Map(),
      1,
    );
    expect(lines).toEqual([
      {
        listingId: 1,
        name: "Bouncy Castle",
        packageGroupId: 7,
        quantity: 4,
        slug: "bounc",
        unitPrice: 400,
      },
      {
        listingId: 1,
        name: "Bouncy Castle",
        quantity: 1,
        slug: "bounc",
        unitPrice: 500,
      },
      {
        listingId: 2,
        name: "Face Painting",
        quantity: 3,
        slug: "facep",
        unitPrice: 300,
      },
    ]);
    // The standalone path carries no package tag at all — not even undefined.
    expect(Object.hasOwn(lines[1]!, "packageGroupId")).toBe(false);
    expect(Object.hasOwn(lines[2]!, "packageGroupId")).toBe(false);
  });

  test("skips paths booked zero times or missing from the map entirely", () => {
    const tree = dualPathTree();
    // The member path is explicitly zero and listing:2 is absent — only the
    // standalone path of listing 1 books.
    const lines = buildOrderLines(
      tree,
      new Map([
        ["listing:1", 1],
        ["package:7/member:1", 0],
      ]),
      new Map(),
      new Map(),
      1,
    );
    expect(lines.map((line) => [line.listingId, line.quantity])).toEqual([
      [1, 1],
    ]);
  });

  test("reads buyer-chosen prices for pay-more listings", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          can_pay_more: true,
          id: 2,
          max_price: 100000,
          slug: "facep",
          unit_price: 300,
        }),
      ],
      slugs: ["facep"],
    });
    const lines = buildOrderLines(
      tree,
      new Map([["listing:2", 1]]),
      new Map([[2, 1]]),
      new Map([[2, 12345]]),
      1,
    );
    expect(lines[0]!.unitPrice).toBe(12345);
  });

  test("prices a customisable member's line by the chosen day count", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          customisable_days: true,
          day_prices: { 2: 600 },
          id: 1,
          slug: "bounc",
        }),
      ],
      packages: [
        treePackage(7, [1], {
          dayPrices: new Map([[1, new Map([[2, 777]])]]),
        }),
      ],
      slugs: ["pkg7s"],
    });
    const lines = buildOrderLines(
      tree,
      new Map([["package:7/member:1", 1]]),
      new Map([[1, 1]]),
      new Map(),
      2,
    );
    expect(lines[0]!.unitPrice).toBe(777);
  });

  test("adds one line per folded child for units the top level does not cover", () => {
    const tree = buildBookingTree({
      childrenByParentId: new Map([
        [1, [resolved({ id: 10, name: "Generator", slug: "genrt" })]],
      ]),
      listings: [resolved({ id: 1, name: "Bouncy Castle", slug: "bounc" })],
      slugs: ["bounc"],
    });
    const lines = buildOrderLines(
      tree,
      new Map([["listing:1", 2]]),
      new Map([
        [1, 2],
        [10, 2],
      ]),
      new Map([[10, 888]]),
      1,
    );
    expect(lines).toEqual([
      {
        listingId: 1,
        name: "Bouncy Castle",
        quantity: 2,
        slug: "bounc",
        unitPrice: 0,
      },
      {
        listingId: 10,
        name: "Generator",
        quantity: 2,
        slug: "genrt",
        unitPrice: 888,
      },
    ]);
    expect(Object.hasOwn(lines[1]!, "packageGroupId")).toBe(false);
  });

  test("skips a folded listing the top-level lines already cover", () => {
    const tree = dualPathTree();
    const nodeQuantities = nodeQuantitiesFor(
      tree,
      new Map([[1, 1]]),
      new Map([[7, 2]]),
    );
    // The fold's aggregate for listing 1 (5) equals its two paths' total, so
    // no child line is invented for it.
    const lines = buildOrderLines(
      tree,
      nodeQuantities,
      new Map([[1, 5]]),
      new Map(),
      1,
    );
    expect(lines.map((line) => line.quantity)).toEqual([4, 1]);
  });
});
