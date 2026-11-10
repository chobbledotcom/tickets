import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  subscriptionCheckoutError,
  subscriptionItemOrNull,
} from "#shared/subscriptions/checkout-rules.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";

const monthly = checkoutItem({
  listingId: 7,
  recurring: { interval: "month", price: 500 },
});
const ordinary = checkoutItem({ listingId: 2 });

const stripeError = (overrides: Partial<CheckoutIntent>): string | null =>
  subscriptionCheckoutError("stripe", checkoutIntent(overrides));

describe("subscription checkout rules", () => {
  test("finds the subscription line of an order", () => {
    expect(
      subscriptionItemOrNull(checkoutIntent({ items: [ordinary, monthly] })),
    ).toBe(monthly);
  });

  test("finds no subscription line in an ordinary order", () => {
    expect(
      subscriptionItemOrNull(checkoutIntent({ items: [ordinary] })),
    ).toBeNull();
  });

  test("lets an ordinary order through on any provider", () => {
    expect(
      subscriptionCheckoutError(
        "square",
        checkoutIntent({ items: [ordinary] }),
      ),
    ).toBeNull();
  });

  test("lets one subscription line through on Stripe, beside other tickets", () => {
    expect(stripeError({ items: [ordinary, monthly] })).toBeNull();
    expect(
      stripeError({
        allocations: [{ childId: 2, parentId: 7, qty: 1 }],
        items: [monthly, ordinary],
      }),
    ).toBeNull();
  });

  test("refuses a subscription on any provider but Stripe", () => {
    for (const provider of ["square", "sumup"] as const) {
      expect(
        subscriptionCheckoutError(
          provider,
          checkoutIntent({ items: [monthly] }),
        ),
      ).toBe(t("payment.error.subscription_needs_stripe"));
    }
  });

  test("refuses a subscription that is not booked on its own", () => {
    const onItsOwn = t("payment.error.subscription_on_its_own");
    const yearly = checkoutItem({
      listingId: 8,
      recurring: { interval: "year", price: 900 },
    });
    expect(stripeError({ items: [monthly, yearly] })).toBe(onItsOwn);
    expect(stripeError({ items: [{ ...monthly, packageGroupId: 3 }] })).toBe(
      onItsOwn,
    );
    expect(
      stripeError({
        allocations: [{ childId: 7, parentId: 2, qty: 1 }],
        items: [ordinary, monthly],
      }),
    ).toBe(onItsOwn);
  });

  test("refuses a subscription paid as a deposit or a balance", () => {
    const noDeposit = t("payment.error.subscription_no_deposit");
    expect(stripeError({ items: [monthly], reservationAmount: "100" })).toBe(
      noDeposit,
    );
    expect(stripeError({ balanceAttendeeId: 4, items: [monthly] })).toBe(
      noDeposit,
    );
  });
});
