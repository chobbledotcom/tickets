import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#booking/build-tree.ts";
import { buildOrderLines } from "#booking/order-lines.ts";
import { resolved } from "#test-utils/booking-model-fixtures.ts";

describe("buildOrderLines: plan and renewal unit terms", () => {
  test("carries a plan line's unit as its initial term", () => {
    const tree = buildBookingTree({
      listings: [
        resolved({
          assignBuiltSite: true,
          id: 4,
          initialSiteMonths: 3,
          name: "Site Plan",
          slug: "plan3",
          unitPrice: 4500,
        }),
      ],
      slugs: ["plan3"],
    });
    const lines = buildOrderLines(
      tree,
      new Map([["listing:4", 2]]),
      new Map([[4, 2]]),
      new Map(),
      1,
      { renewal: false },
    );
    expect(lines).toEqual([
      {
        listingId: 4,
        name: "Site Plan",
        purchaseUnit: { kind: "months", monthsPerUnit: 3 },
        quantity: 2,
        slug: "plan3",
        unitPrice: 4500,
      },
    ]);
  });

  test("prices a renewal order's tier lines by their months per unit", () => {
    // A renewal tier is hidden and purchase-only; the renewal purchase context
    // — not the listing's facts alone — makes its units count months.
    const tree = buildBookingTree({
      listings: [
        resolved({
          hidden: true,
          id: 5,
          monthsPerUnit: 2,
          name: "Monthly",
          purchaseOnly: true,
          slug: "monthl",
          unitPrice: 700,
        }),
      ],
      slugs: ["monthl"],
    });
    const lines = buildOrderLines(
      tree,
      new Map([["listing:5", 3]]),
      new Map([[5, 3]]),
      new Map(),
      1,
      { renewal: true },
    );
    expect(lines).toEqual([
      {
        listingId: 5,
        name: "Monthly",
        purchaseUnit: { kind: "months", monthsPerUnit: 2 },
        quantity: 3,
        slug: "monthl",
        unitPrice: 700,
      },
    ]);
  });
});
