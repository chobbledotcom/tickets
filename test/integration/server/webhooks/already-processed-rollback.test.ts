// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectKeptAsQuantityZeroAndRefunded,
  expectKeptAtQuantityZero,
  expectRefundNote,
  expectWebhookKeptAndRefunded,
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > already-processed rollback",
  { db: true },
  () => {
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

      await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_multi_inactive_wh",
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
          paymentIntent: "pi_multi_inactive_wh",
          sessionId: "cs_multi_inactive_wh",
        }),
        "re_test",
      );
      await expectRefundNote(listing2.id, "registration closed");

      await expectKeptAtQuantityZero(listing1.id);
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

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_multi_soldout_wh",
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
          paymentIntent: "pi_multi_soldout_wh",
          sessionId: "cs_multi_soldout_wh",
        }),
      );

      // Signed by us → the whole order is kept as a quantity-0 placeholder
      // (one attendee against both listings), not dropped, and refunded once.
      await expectKeptAsQuantityZeroAndRefunded(
        listing1.id,
        "cs_multi_soldout_wh",
        mockRefund,
      );
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

      // Record the session as already paid for and booked, so the retry below
      // is a replay of a finished payment rather than a fresh one.
      const { createAggregatePayment } = await import(
        "#test-utils/payment-aggregate.ts"
      );
      await createAggregatePayment({
        attendeeId: attResult.attendees[0]!.id,
        charges: [{ amount: 1000, reference: "pi_del_listing_wh" }],
        paymentId: "cs_del_listing_wh",
        state: "completed",
        ticketTokens: ["tok-test"],
      });

      // The metadata points at a since-deleted listing (99999). Because the
      // session is already finalized (the attendee exists), the retry is an
      // idempotent success replay — a missing listing only means no thank-you
      // URL, not a "Listing not found" error for a payment that succeeded.
      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_del_listing_wh",
          metadata: signedMeta(
            {
              email: "deleted@example.com",
              items: singleItem(99999, 1, 1000),
              name: "Deleted Listing",
            },
            1000,
          ),
          paymentIntent: "pi_del_listing_wh",
          sessionId: "cs_del_listing_wh",
        }),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
        },
        200,
        (json) => {
          expect(json.processed).toBe(true);
          expect(json.error).toBeUndefined();
        },
      );
    });
  },
);
