import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  bookAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv(
  "server webhooks > already-processed rollback",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("webhook handles multi-ticket with inactive listing and rollback", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Active",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Inactive",
        unitPrice: 500,
      });
      await deactivateTestListing(listing2.id);

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
                  id: "cs_multi_inactive_wh",
                  metadata: signedMeta(
                    {
                      email: "inactive@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 500, q: 1 },
                      ]),
                      name: "Multi Inactive",
                    },
                    1000,
                  ),
                  payment_intent: "pi_multi_inactive_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_inactive_wh",
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
            expect(json.error).toContain("no longer accepting");
          },
        );

        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook handles multi-ticket sold out in second listing", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Avail",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi WH Full",
        unitPrice: 500,
      });
      await bookAttendee(listing2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
        quantity: 1,
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
                  id: "cs_multi_soldout_wh",
                  metadata: signedMeta(
                    {
                      email: "soldout@example.com",
                      items: JSON.stringify([
                        { e: listing1.id, p: 500, q: 1 },
                        { e: listing2.id, p: 500, q: 1 },
                      ]),
                      name: "Sold Out Multi",
                    },
                    1000,
                  ),
                  payment_intent: "pi_multi_soldout_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_multi_soldout_wh",
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
            // The sold-out reason now lives in the note; the customer sees the
            // generic saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );

        // Signed by us → the whole order is kept as a quantity-0 placeholder
        // (one attendee against both listings), not dropped, and refunded once.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]!.quantity).toBe(0);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees1[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_multi_soldout_wh");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });

    test("webhook replays an already-processed session as success even if its listing was deleted", async () => {
      await setupStripe();

      // Create a real listing and attendee to satisfy FK constraints for finalization
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "WH Del Evt",
        unitPrice: 500,
      });
      const attResult = await bookAttendee(listing, {
        email: "whdel@example.com",
        name: "WH Del",
        paymentId: "pi_del",
        quantity: 1,
      });
      if (!attResult.success) throw new Error("Failed to create attendee");

      // Reserve and finalize the session with the real attendee
      const {
        reserveSession: reserveSessionFn,
        finalizeSession: finalizeSessionFn,
      } = await import("#shared/db/processed-payments.ts");
      await reserveSessionFn("cs_del_listing_wh");
      await finalizeSessionFn("cs_del_listing_wh", attResult.attendees[0]!.id, [
        "tok-test",
      ]);

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      // The metadata points at a since-deleted listing (99999). Because the
      // session is already finalized (the attendee exists), the retry is an
      // idempotent success replay — a missing listing only means no thank-you
      // URL, not a "Listing not found" error for a payment that succeeded.
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1000,
                  id: "cs_del_listing_wh",
                  metadata: signedMeta(
                    {
                      email: "deleted@example.com",
                      items: singleItem(99999, 1, 1000),
                      name: "Deleted Listing",
                    },
                    1000,
                  ),
                  payment_intent: "pi_del_listing_wh",
                  payment_status: "paid",
                },
              },
              id: "evt_del_listing_wh",
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
            expect(json.error).toBeUndefined();
          },
        );
      } finally {
        mockVerify.restore();
      }
    });
  },
);
