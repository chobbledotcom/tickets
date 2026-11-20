import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addedTaxByOrder } from "#shared/tax/added.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import type { TaxState } from "#shared/tax/transitions.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

const basis = { lines: [{ gross: 1000, listingId: 1 }], modifiers: [] };

const saved = (
  bookingGroup: string,
  policy: TaxPolicy,
  revision: number,
  kind: TaxState["kind"] = "active",
) => ({
  bookingGroup,
  state: { assessment: assessTax(basis, policy), kind, revision },
});

const addTax = { mode: "add_to_total", rateBasisPoints: 2000 } as const;

describe("addedTaxByOrder", () => {
  test("holds the tax that an active tax-added order adds", () => {
    expect(addedTaxByOrder([saved("order-a", addTax, 0)])).toEqual(
      new Map([["order-a", 200]]),
    );
  });

  test("leaves out an order whose prices already hold their tax", () => {
    const included = { mode: "calculate_from_total", rateBasisPoints: 2000 };
    expect(addedTaxByOrder([saved("order-a", included, 0)]).size).toBe(0);
  });

  test("leaves out an order with no tax", () => {
    expect(addedTaxByOrder([saved("order-a", { mode: "none" }, 0)]).size).toBe(
      0,
    );
  });

  test("leaves out a refunded order", () => {
    expect(
      addedTaxByOrder([saved("order-a", addTax, 1, "refunded")]).size,
    ).toBe(0);
  });

  test("reads the latest saved assessment of each order", () => {
    const included = { mode: "calculate_from_total", rateBasisPoints: 2000 };
    const reassessed = addedTaxByOrder([
      saved("order-a", addTax, 0),
      saved("order-a", included, 1),
      saved("order-b", addTax, 0),
    ]);
    expect(reassessed).toEqual(new Map([["order-b", 200]]));
  });
});
