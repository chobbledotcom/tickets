import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as fc from "fast-check";
import {
  firstRecurringChargeAt,
  planOfStart,
  recurringCharge,
  type SubscriptionStart,
  vatInRecurringPayment,
} from "#shared/subscriptions/plan.ts";
import { NO_TAX } from "#shared/tax/types.ts";

const seedArgs = { numRuns: 500, seed: 20261110 } as const;
const ADDED = { mode: "add_to_total", rateBasisPoints: 2000 } as const;
const INCLUDED = {
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
} as const;
const unixSeconds = (iso: string): number => Date.parse(iso) / 1000;

const start: SubscriptionStart = {
  amount: 1200,
  id: "sub_1",
  interval: "month",
  listingId: 4,
  status: "trialing",
};

describe("subscription plan", () => {
  test("charges the recurring price for the whole quantity", () => {
    const listing = { id: 4, recurringPrice: 500 };
    expect(recurringCharge(listing, 3, NO_TAX)).toBe(1500);
    expect(recurringCharge(listing, 3, INCLUDED)).toBe(1500);
    expect(recurringCharge(listing, 3, ADDED)).toBe(1800);
  });

  test("finds no VAT when the site charges none", () => {
    expect(vatInRecurringPayment(4, 1200, NO_TAX)).toBe(0);
  });

  test("finds the VAT inside a payment at the frozen rate", () => {
    expect(vatInRecurringPayment(4, 1200, INCLUDED)).toBe(200);
    expect(vatInRecurringPayment(4, 1200, ADDED)).toBe(200);
  });

  test("recovers exactly the VAT that an added-VAT charge carries", () => {
    const plans = fc.record({
      price: fc.integer({ max: 10_000_000, min: 0 }),
      quantity: fc.integer({ max: 5000, min: 1 }),
      rateBasisPoints: fc.integer({ max: 10_000, min: 0 }),
    });
    fc.assert(
      fc.property(plans, ({ price, quantity, rateBasisPoints }) => {
        const policy = { mode: "add_to_total", rateBasisPoints } as const;
        const charge = recurringCharge(
          { id: 1, recurringPrice: price },
          quantity,
          policy,
        );
        const added = charge - price * quantity;
        expect(vatInRecurringPayment(1, charge, policy)).toBe(added);
      }),
      seedArgs,
    );
  });

  test("first charges again one period after the first payment", () => {
    const now = unixSeconds("2026-01-31T10:00:00Z");
    expect(firstRecurringChargeAt(now, "week")).toBe(
      unixSeconds("2026-02-07T10:00:00Z"),
    );
    expect(firstRecurringChargeAt(now, "month")).toBe(
      unixSeconds("2026-02-28T10:00:00Z"),
    );
    expect(firstRecurringChargeAt(now, "year")).toBe(
      unixSeconds("2027-01-31T10:00:00Z"),
    );
  });

  test("keeps the plan Stripe reported, with its VAT", () => {
    expect(planOfStart(start, INCLUDED)).toEqual({
      amount: 1200,
      id: "sub_1",
      interval: "month",
      status: "trialing",
      tax: 200,
    });
    expect(planOfStart(start, NO_TAX).tax).toBe(0);
  });
});
