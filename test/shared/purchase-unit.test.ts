import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bookedMonths, resolvePurchaseUnit } from "#shared/purchase-unit.ts";
import { testListing } from "#test-utils/factories.ts";

describe("resolvePurchaseUnit", () => {
  test("counts an assigned-site plan's units in its initial term", () => {
    const plan = testListing({
      assign_built_site: true,
      initial_site_months: 3,
    });
    expect(resolvePurchaseUnit(plan, { renewal: false })).toEqual({
      kind: "months",
      monthsPerUnit: 3,
    });
  });

  test("counts a renewal tier's units in their months per unit", () => {
    const tier = testListing({
      hidden: true,
      months_per_unit: 2,
      purchase_only: true,
    });
    expect(resolvePurchaseUnit(tier, { renewal: true })).toEqual({
      kind: "months",
      monthsPerUnit: 2,
    });
  });

  test("counts an ordinary listing's units as tickets", () => {
    expect(resolvePurchaseUnit(testListing(), { renewal: false })).toEqual({
      kind: "tickets",
    });
  });

  test("keeps a retired plan on tickets once its flag is off", () => {
    const retired = testListing({
      assign_built_site: false,
      initial_site_months: 3,
    });
    expect(resolvePurchaseUnit(retired, { renewal: false })).toEqual({
      kind: "tickets",
    });
  });

  test("counts a renewal context's non-tier listings as tickets", () => {
    // A renewal page only offers qualifying tiers, so a listing that prices
    // no positive whole months per unit cannot be renewed: its units stay
    // what they are.
    for (const months_per_unit of [0, -1, 1.5]) {
      expect(
        resolvePurchaseUnit(
          { assign_built_site: false, months_per_unit },
          { renewal: true },
        ),
      ).toEqual({ kind: "tickets" });
    }
    expect(
      resolvePurchaseUnit(
        { assign_built_site: false, months_per_unit: undefined },
        { renewal: true },
      ),
    ).toEqual({ kind: "tickets" });
  });

  test("throws for an enabled plan that states no initial term", () => {
    const zeroed = testListing({
      assign_built_site: true,
      initial_site_months: 0,
    });
    expect(() => resolvePurchaseUnit(zeroed, { renewal: false })).toThrow(
      "assigned-site plan states no initial months",
    );
    const unstated = testListing({ assign_built_site: true });
    delete (unstated as { initial_site_months?: number }).initial_site_months;
    expect(() => resolvePurchaseUnit(unstated, { renewal: false })).toThrow(
      "assigned-site plan states no initial months",
    );
    const negative = testListing({
      assign_built_site: true,
      initial_site_months: -2,
    });
    expect(() => resolvePurchaseUnit(negative, { renewal: true })).toThrow(
      "assigned-site plan states no initial months",
    );
  });
});

describe("bookedMonths", () => {
  test("totals a plan line's months from its term times its quantity", () => {
    const plan = testListing({
      assign_built_site: true,
      initial_site_months: 3,
    });
    expect(bookedMonths(plan, 3)).toBe(9);
    expect(bookedMonths(plan, 1)).toBe(3);
  });

  test("a plain ticket booking covers no months", () => {
    expect(bookedMonths(testListing(), 2)).toBe(0);
  });

  test("a line whose listing stopped assigning a site covers no months", () => {
    const retired = testListing({
      assign_built_site: false,
      initial_site_months: 3,
    });
    expect(bookedMonths(retired, 2)).toBe(0);
  });

  test("throws for a stored plan that states no term", () => {
    const zeroed = testListing({
      assign_built_site: true,
      initial_site_months: 0,
    });
    expect(() => bookedMonths(zeroed, 2)).toThrow(
      "assigned-site plan states no initial months",
    );
  });
});
