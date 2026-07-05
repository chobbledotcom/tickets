import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv(
  "server webhooks > customisable-days pricing",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("prices a customisable-days webhook booking by the chosen day count", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
        maximumDaysAfter: 90,
        minimumDaysBefore: 0,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  // 3-day price (2500), not the 1-day unit price.
                  amount_total: 2500,
                  id: "cs_customisable",
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      day_count: "3",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Trip Buyer",
                    },
                    2500,
                  ),
                  payment_intent: "pi_customisable",
                  payment_status: "paid",
                },
              },
              id: "evt_customisable",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(true);
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        // Created at the day-count price and start date — proving the webhook
        // re-priced and dated the booking by the chosen span, not the listing's
        // flat unit price.
        expect(Number(attendees[0]?.price_paid)).toBe(2500);
        expect(attendees[0]?.date).toBe("2026-07-01");
      } finally {
        mockVerify.restore();
      }
    });

    test("defaults a customisable-days webhook with no day_count to a single day", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1000,
                  id: "cs_no_daycount",
                  // No day_count → the booking falls back to the 1-day price.
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      name: "Trip Buyer",
                    },
                    1000,
                  ),
                  payment_intent: "pi_no_daycount",
                  payment_status: "paid",
                },
              },
              id: "evt_no_daycount",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(true);
          },
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(Number(attendees[0]?.price_paid)).toBe(1000);
      } finally {
        mockVerify.restore();
      }
    });

    test("keeps and refunds a customisable-days webhook whose day count has no price", async () => {
      await setupStripe();

      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 50,
      });

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 2500,
                  id: "cs_bad_daycount",
                  metadata: signedMeta(
                    {
                      date: "2026-07-01",
                      // 9 isn't an offered count, so the expected price is 0 and
                      // the charged amount can't be reconciled.
                      day_count: "9",
                      email: "trip@example.com",
                      items: singleItem(listing.id, 1, 2500),
                      name: "Trip Buyer",
                    },
                    2500,
                  ),
                  payment_intent: "pi_bad_daycount",
                  payment_status: "paid",
                },
              },
              id: "evt_bad_daycount",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The reason now lives in the note; the customer sees the generic
            // saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );
        // Signed by us → the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_bad_daycount");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  },
);
