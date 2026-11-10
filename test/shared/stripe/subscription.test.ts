import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { subscriptionStartOf } from "#shared/stripe/subscription.ts";
import { stripeSubscription } from "#test-utils/stripe/fixtures.ts";

const paidBy = (
  entries: { intent: string | null; status: string; type: string }[],
) =>
  stripeSubscription({
    latest_invoice: {
      payments: {
        data: entries.map(({ intent, status, type }) => ({
          payment: { payment_intent: intent, type },
          status,
        })),
      },
    },
  });

describe("Stripe subscription start", () => {
  test("reads the plan and the intent that paid the first invoice", () => {
    expect(
      subscriptionStartOf(
        stripeSubscription({
          id: "sub_9",
          items: {
            data: [
              {
                price: { recurring: { interval: "year" }, unit_amount: 600 },
                quantity: 3,
              },
            ],
          },
          metadata: { listing_id: "12" },
          status: "active",
        }),
      ),
    ).toEqual({
      paymentReference: "pi_first",
      start: {
        amount: 1800,
        id: "sub_9",
        interval: "year",
        listingId: 12,
        status: "active",
      },
    });
  });

  test("skips a payment that failed or was not an intent", () => {
    const subscription = paidBy([
      { intent: "pi_failed", status: "failed", type: "payment_intent" },
      { intent: null, status: "paid", type: "out_of_band_payment" },
      { intent: "pi_paid", status: "paid", type: "payment_intent" },
    ]);
    expect(subscriptionStartOf(subscription).paymentReference).toBe("pi_paid");
  });

  test("names no payment when the first invoice is unpaid", () => {
    const subscription = paidBy([
      { intent: "pi_open", status: "open", type: "payment_intent" },
    ]);
    expect(subscriptionStartOf(subscription).paymentReference).toBe("");
  });

  test("refuses a subscription that names no listing", () => {
    for (const metadata of [{}, { listing_id: "0" }]) {
      expect(() =>
        subscriptionStartOf(stripeSubscription({ id: "sub_x", metadata })),
      ).toThrow("Stripe subscription sub_x names no listing in its metadata");
    }
  });
});
