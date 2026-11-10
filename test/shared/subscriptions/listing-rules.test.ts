import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { recurringPlanError } from "#shared/subscriptions/listing-rules.ts";
import { inputFor } from "#test/shared/listings-actions/helpers.ts";

const withPlan = (overrides: Partial<ListingInput>): string | null =>
  recurringPlanError(inputFor({ unitPrice: 1000, ...overrides }));

describe("recurring plan rule", () => {
  test("lets an ordinary ticket through", () => {
    expect(recurringPlanError(inputFor({}))).toBeNull();
    expect(withPlan({ recurringInterval: "", recurringPrice: 0 })).toBeNull();
  });

  test("lets a priced plan with a frequency through", () => {
    expect(
      withPlan({ recurringInterval: "month", recurringPrice: 500 }),
    ).toBeNull();
  });

  test("asks for a price when only the frequency is set", () => {
    expect(withPlan({ recurringInterval: "week", recurringPrice: 0 })).toBe(
      t("error.recurring_price_required"),
    );
  });

  test("refuses a price that is not a whole amount above zero", () => {
    for (const recurringPrice of [-1, 2.5]) {
      expect(withPlan({ recurringInterval: "year", recurringPrice })).toBe(
        t("error.recurring_price_required"),
      );
    }
  });

  test("asks for a frequency when only the price is set", () => {
    expect(withPlan({ recurringInterval: "", recurringPrice: 500 })).toBe(
      t("error.recurring_interval_required"),
    );
    expect(withPlan({ recurringPrice: 500 })).toBe(
      t("error.recurring_interval_required"),
    );
  });

  test("needs a ticket price for the first payment", () => {
    const plan = { recurringInterval: "month", recurringPrice: 500 } as const;
    expect(withPlan({ ...plan, unitPrice: 0 })).toBe(
      t("error.recurring_needs_ticket_price"),
    );
    expect(recurringPlanError(inputFor(plan))).toBe(
      t("error.recurring_needs_ticket_price"),
    );
  });
});
