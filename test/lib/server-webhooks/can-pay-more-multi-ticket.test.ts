// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectKeptAsQuantityZeroAndRefunded,
  expectRefundedWithNote,
  expectSessionFailed,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > can_pay_more (multi-ticket)",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket can_pay_more uses per-item prices from metadata", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        name: "Multi Pay More 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Pay More 2",
        unitPrice: 1000,
      });

      // Listing1 base 500, user entered 2000; Listing2 base 1000, stays 1000
      // Total: 2000 + 1000 = 3000
      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 3000,
          eventId: "evt_multi_pay_more",
          metadata: signedMeta(
            {
              email: "generous@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 2000, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Multi Generous",
            },
            3000,
          ),
          paymentIntent: "pi_multi_pay_more",
          sessionId: "cs_multi_pay_more",
        }),
      );

      // Verify both attendees were created with correct per-item prices
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(
        (attendees1[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(2000);
      expect(attendees2.length).toBe(1);
      expect(
        (attendees2[0] as unknown as Record<string, unknown>).price_paid,
      ).toBe(1000);
    });

    test("multi-ticket keeps and refunds amount above listing price when can_pay_more is disabled", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Pay More",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Normal Price",
        unitPrice: 1000,
      });

      // Same metadata shape as the pay-more test, but listing1 has can_pay_more=false
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 3000,
          eventId: "evt_no_pay_more",
          metadata: signedMeta(
            {
              email: "over@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 2000, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Over Payer",
            },
            3000,
          ),
          paymentIntent: "pi_no_pay_more",
          sessionId: "cs_no_pay_more",
        }),
        "re_no_pay_more",
      );

      // Signed by us → the order is kept as one quantity-0 placeholder across
      // both listings and refunded once, with a system note.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(1);
      expect(attendees1[0]!.id).toBe(attendees2[0]!.id);
      expect(attendees1[0]!.quantity).toBe(0);
      await expectRefundedWithNote(attendees1[0]!.id, mockRefund);
      await expectSessionFailed("cs_no_pay_more");
    });

    test("multi-ticket can_pay_more accepts total at max_price × quantity boundary", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20000 is exactly at the boundary → should be accepted
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 20000,
          eventId: "evt_qty2_at_max",
          metadata: signedMeta(
            {
              email: "boundary@example.com",
              items: singleItem(listing.id, 2, 20000),
              name: "Boundary User",
            },
            20000,
          ),
          paymentIntent: "pi_qty2_at_max",
          sessionId: "cs_qty2_at_max",
        }),
      );

      // Verify one attendee record was created (quantity=2 is stored on the record)
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]!.quantity).toBe(2);
    });

    test("multi-ticket can_pay_more keeps and refunds total above max_price × quantity", async () => {
      await setupStripe();

      // unitPrice=1000, maxPrice=10000 (default), quantity=2
      // maxWithFee = 10000 * 2 = 20000 (no booking fee in tests)
      // amount_total=20001 exceeds the boundary → should be refunded
      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 20001,
          eventId: "evt_qty2_over_max",
          metadata: signedMeta(
            {
              email: "overpay-qty2@example.com",
              items: singleItem(listing.id, 2, 20001),
              name: "Overpay Qty2 User",
            },
            20001,
          ),
          paymentIntent: "pi_qty2_over_max",
          sessionId: "cs_qty2_over_max",
        }),
        "re_qty2_over_max",
      );

      // Signed by us → the booking is kept as a quantity-0 placeholder and
      // refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_qty2_over_max",
        mockRefund,
      );
    });
  },
);
