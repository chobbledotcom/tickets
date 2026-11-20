// test-groups: run-alone
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import {
  restoreCancellationProvider,
  withRestoredProvider,
} from "#scripts/verify-models/subscriptions/cancellation-support.ts";
import {
  MODEL_TIME,
  paidInvoice,
  providerSubscription,
  seedBooking,
  withSubscriptionDb,
} from "#scripts/verify-models/subscriptions/environment.ts";
import { stripeApi } from "#shared/stripe.ts";

/** Every provider boundary the fixture can replace, discovered from the API
 * object so the list cannot drift from it. */
const providerMethods = (
  Object.keys(stripeApi) as (keyof typeof stripeApi)[]
).filter((method) => typeof stripeApi[method] === "function");

describe("subscription model fixtures", () => {
  for (const interval of ["week", "month", "year"] as const) {
    test(`keeps the supplied ${interval} subscription facts`, () => {
      expect(
        providerSubscription({
          amount: 925,
          id: "sub_fixture",
          interval,
          listingId: 42,
          status: "canceled",
        }),
      ).toEqual({
        id: "sub_fixture",
        items: {
          data: [
            {
              price: { recurring: { interval }, unit_amount: 925 },
              quantity: 1,
            },
          ],
        },
        metadata: { listing_id: "42" },
        status: "canceled",
      });
    });
  }

  test("keeps the invoice defaults, model time, and supplied amount", () => {
    for (const amount of [undefined, 0, 925]) {
      expect(paidInvoice("in_fixture", amount)).toEqual({
        amount_paid: amount ?? 600,
        billing_reason: "subscription_cycle",
        currency: "gbp",
        id: "in_fixture",
        status_transitions: { paid_at: Date.parse(MODEL_TIME) / 1000 },
      });
    }
  });

  test("seeds ordinary and subscribed rows on the same attendee and listing", async () => {
    await withSubscriptionDb(async () => {
      await seedBooking({ attendeeId: 7, id: 11, listingId: 23, quantity: 2 });
      await seedBooking({
        attendeeId: 7,
        id: 12,
        listingId: 23,
        plan: {
          amount: 925,
          id: "sub_fixture",
          interval: "year",
          status: "canceled",
          tax: 125,
        },
        quantity: 0,
      });
      const rows = await readRows(
        from(tables.listing_attendees)
          .sortedBy("id")
          .pick(
            "id",
            "attendeeId",
            "listingId",
            "quantity",
            "recurringPrice",
            "recurringTax",
            "recurringInterval",
            "subscriptionId",
            "subscriptionStatus",
          ),
      );
      expect(rows).toEqual([
        {
          attendeeId: 7,
          id: 11,
          listingId: 23,
          quantity: 2,
          recurringInterval: "",
          recurringPrice: 0,
          recurringTax: 0,
          subscriptionId: "",
          subscriptionStatus: "",
        },
        {
          attendeeId: 7,
          id: 12,
          listingId: 23,
          quantity: 0,
          recurringInterval: "year",
          recurringPrice: 925,
          recurringTax: 125,
          subscriptionId: "sub_fixture",
          subscriptionStatus: "canceled",
        },
      ]);
    });
  });

  for (const fails of [false, true]) {
    test(`restores all provider methods after a call that ${fails ? "throws" : "returns"}`, async () => {
      const previous = { ...stripeApi };
      const restore = restoreCancellationProvider();
      const fault = new Error("fixture call failed");
      const replacement = () => Promise.reject(fault);
      const probe = { calls: 0 };
      try {
        for (const method of providerMethods) stripeApi[method] = replacement;
        const result = withRestoredProvider(restore, probe, (observed) => {
          expect(observed).toBe(probe);
          observed.calls++;
          return fails ? Promise.reject(fault) : Promise.resolve(probe);
        });
        if (fails) await expect(result).rejects.toBe(fault);
        else expect(await result).toBe(probe);
        expect(probe.calls).toBe(1);
        for (const method of providerMethods) {
          expect(stripeApi[method]).toBe(previous[method]);
        }
      } finally {
        restore();
      }
    });
  }
});
