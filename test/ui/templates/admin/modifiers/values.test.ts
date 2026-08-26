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
          calc_kind: "percent",
          calc_value: 10,
          direction: "discount",
        }),
      ),
    ).toBe("Discount · 10%");
  });

  test("summarises a fixed charge", () => {
    expect(
      ruleSummary(
        testModifier({
          calc_kind: "fixed",
          calc_value: 500,
          direction: "charge",
        }),
      ),
    ).toBe("Charge · 500");
  });

  test("summarises a multiply rule without a direction word", () => {
    expect(
      ruleSummary(testModifier({ calc_kind: "multiply", calc_value: 1.5 })),
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
        min_subtotal: 2500,
        min_visits: 3,
        stock: 8,
      }),
    );
    expect(values.active).toBe("");
    expect(values.min_subtotal).toBe(25);
    expect(values.min_visits).toBe(3);
    expect(values.stock).toBe(8);
  });

  test("prefills the max times per order, blank when uncapped", () => {
    const capped = modifierToFieldValues(
      testModifier({ max_per_order: 2, trigger: "answer" }),
    );
    expect(capped.max_per_order).toBe(2);

    const uncapped = modifierToFieldValues(
      testModifier({ max_per_order: null, trigger: "answer" }),
    );
    expect(uncapped.max_per_order).toBe("");
  });

  test("keeps an explicit zero max_per_order as 0, not blank", () => {
    // max_per_order is `?? ""` (nullish), like stock — a stored 0 (refused at
    // the form, but possible by direct repair) must survive a re-render.
    const values = modifierToFieldValues(testModifier({ max_per_order: 0 }));
    expect(values.max_per_order).toBe(0);
  });

  test("renders a zero min_subtotal and absent stock as blank", () => {
    const values = modifierToFieldValues(
      testModifier({ min_subtotal: 0, min_visits: 0, stock: null }),
    );
    expect(values.min_subtotal).toBe("");
    expect(values.min_visits).toBe("");
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
        testModifier({ total_uses: 7, usage_count: 3 }),
      ),
    ).toEqual({ total_uses: 7, usage_count: 3 });
  });
});
