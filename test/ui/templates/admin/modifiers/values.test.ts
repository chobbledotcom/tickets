import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  modifierAggregateToFieldValues,
  modifierToFieldValues,
  ruleSummary,
} from "#templates/admin/modifiers/values.ts";
import { testModifier } from "#test-utils/factories.ts";

describe("ruleSummary", () => {
  test("summarises a percent discount", () => {
    expect(
      ruleSummary(
        testModifier({
          calcKind: "percent",
          calcValue: 10,
          direction: "discount",
        }),
      ),
    ).toBe("Discount · 10%");
  });

  test("summarises a fixed charge", () => {
    expect(
      ruleSummary(
        testModifier({
          calcKind: "fixed",
          calcValue: 500,
          direction: "charge",
        }),
      ),
    ).toBe("Charge · 500");
  });

  test("summarises a multiply rule without a direction word", () => {
    expect(
      ruleSummary(testModifier({ calcKind: "multiply", calcValue: 1.5 })),
    ).toBe("Multiply · ×1.5");
  });
});

describe("modifierToFieldValues", () => {
  test("defaults a new modifier to active with blank optional fields", () => {
    const values = modifierToFieldValues();
    expect(values.active).toBe("1");
  });

  test("maps a stored modifier's fields, converting money to major units", () => {
    const values = modifierToFieldValues(
      testModifier({
        active: false,
        minSubtotal: 2500,
        minVisits: 3,
        stock: 8,
      }),
    );
    expect(values.active).toBe("");
    expect(values.minSubtotal).toBe(25);
    expect(values.minVisits).toBe(3);
    expect(values.stock).toBe(8);
  });

  test("prefills the max times per order, blank when uncapped", () => {
    const capped = modifierToFieldValues(
      testModifier({ maxPerOrder: 2, trigger: "answer" }),
    );
    expect(capped.maxPerOrder).toBe(2);

    const uncapped = modifierToFieldValues(
      testModifier({ maxPerOrder: null, trigger: "answer" }),
    );
    expect(uncapped.maxPerOrder).toBe("");
  });

  test("keeps an explicit zero max_per_order as 0, not blank", () => {
    // max_per_order is `?? ""` (nullish), like stock — a stored 0 (refused at
    // the form, but possible by direct repair) must survive a re-render.
    const values = modifierToFieldValues(testModifier({ maxPerOrder: 0 }));
    expect(values.maxPerOrder).toBe(0);
  });

  test("renders a zero min_subtotal and absent stock as blank", () => {
    const values = modifierToFieldValues(
      testModifier({ minSubtotal: 0, minVisits: 0, stock: null }),
    );
    expect(values.minSubtotal).toBe("");
    expect(values.minVisits).toBe("");
    expect(values.stock).toBe("");
  });

  test("keeps an explicit zero stock as 0, not blank", () => {
    // stock is `?? ""` (nullish), not `|| ""` — a real limit of 0 must survive.
    const values = modifierToFieldValues(testModifier({ stock: 0 }));
    expect(values.stock).toBe(0);
  });
});

describe("modifierAggregateToFieldValues", () => {
  test("projects the two count aggregates", () => {
    expect(
      modifierAggregateToFieldValues(
        testModifier({ totalUses: 7, usageCount: 3 }),
      ),
    ).toEqual({ totalUses: 7, usageCount: 3 });
  });
});
