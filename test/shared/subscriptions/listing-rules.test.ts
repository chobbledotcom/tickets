import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { recurringPlanError } from "#shared/subscriptions/listing-rules.ts";
import { inputFor } from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupStripe } from "#test-utils/settings.ts";

const withPlan = (overrides: Partial<ListingInput>): string | null =>
  recurringPlanError(inputFor({ unitPrice: 1000, ...overrides }));

const MONTHLY = { recurringInterval: "month", recurringPrice: 500 } as const;

describeWithEnv("recurring plan rule", { db: true }, () => {
  beforeEach(() => setupStripe());

  test("lets an ordinary ticket through", () => {
    expect(recurringPlanError(inputFor({}))).toBeNull();
    expect(withPlan({ recurringInterval: "", recurringPrice: 0 })).toBeNull();
  });

  test("lets a priced plan with a frequency through", () => {
    expect(withPlan(MONTHLY)).toBeNull();
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
    expect(withPlan({ ...MONTHLY, unitPrice: 0 })).toBe(
      t("error.recurring_needs_ticket_price"),
    );
    expect(recurringPlanError(inputFor(MONTHLY))).toBe(
      t("error.recurring_needs_ticket_price"),
    );
  });

  test("needs Stripe to charge the plan", async () => {
    await settings.update.setPaymentProviderNone();
    expect(withPlan(MONTHLY)).toBe(t("error.recurring_needs_stripe"));
    expect(withPlan({ recurringInterval: "", recurringPrice: 0 })).toBeNull();
  });
});
