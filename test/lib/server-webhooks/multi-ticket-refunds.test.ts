import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  bookAttendee,
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectKeptAsQuantityZeroAndRefunded,
  expectRefundedWithNote,
  expectSessionFailed,
  expectWebhookKeptAndRefunded,
  postWebhookAndAssert,
  setupStripe,
  signedMeta,
  stubWebhookVerify,
} from "#test-utils";

describeWithEnv(
  "server webhooks > multi-ticket price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("multi-ticket webhook keeps and refunds when capacity exceeded", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi WH Cap 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi WH Cap 2",
        unitPrice: 300,
      });

      // Fill listing2 to capacity
      await bookAttendee(listing2, {
        email: "existing@example.com",
        name: "Existing",
        quantity: 1,
      });

      const mockVerify = await stubWebhookVerify(
        checkoutSessionEvent({
          amountTotal: 800,
          eventId: "evt_multi_cap",
          metadata: signedMeta(
            {
              email: "cap@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 300, q: 1 },
              ]),
              name: "Multi Cap",
            },
            800,
          ),
          paymentIntent: "pi_multi_cap",
          sessionId: "cs_multi_cap",
        }),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(
          true as unknown as Awaited<
            ReturnType<typeof stripeApi.refundPayment>
          >,
        ),
      );

      await postWebhookAndAssert(
        () => {
          mockVerify.restore();
          mockRefund.restore();
        },
        200,
        (json) => {
          expect(json.processed).toBe(false);
          // The capacity reason now lives in the note; the customer sees the
          // generic saved-details message.
          expect(json.error).toContain("saved your details");
        },
      );

      // Signed by us → the order is kept as a quantity-0 placeholder (one
      // attendee across both listings), not dropped, and refunded once.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]!.quantity).toBe(0);
      await expectRefundedWithNote(attendees1[0]!.id, mockRefund);
      await expectSessionFailed("cs_multi_cap");
    });

    test("multi-ticket is kept and refunded when prices changed since checkout", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Mismatch 2",
        unitPrice: 300,
      });

      // expectedTotal = 500*1 + 300*2 = 1100, but amountTotal = 1000
      // Price changed after checkout was created — should refund
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_multi_mismatch",
          metadata: signedMeta(
            {
              email: "multimismatch@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 400, q: 1 },
                { e: listing2.id, p: 600, q: 2 },
              ]),
              name: "Multi Mismatch",
            },
            1000,
          ),
          paymentIntent: "pi_multi_mismatch",
          sessionId: "cs_multi_mismatch",
        }),
        "re_multi_mismatch",
      );

      // The multi-listing booking is kept across both listings as one
      // quantity-0 placeholder and refunded once, with a system note.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(1);
      expect(attendees1[0]!.id).toBe(attendees2[0]!.id);
      expect(attendees1[0]!.quantity).toBe(0);
      const { getNoteRows } = await import("#shared/db/system-notes.ts");
      expect((await getNoteRows([attendees1[0]!.id])).length).toBe(1);
      await expectSessionFailed("cs_multi_mismatch");

      // Verify refund was attempted exactly once
      expect(mockRefund.calls.length).toBe(1);
      expect(mockRefund.calls[0]!.args).toEqual(["pi_multi_mismatch"]);
    });

    test("multi-ticket keeps and refunds when per-item p does not match unit_price * q for non-pay-more listing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // p=500 but listing costs 1000*1=1000, and listing is not can_pay_more
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_item_mismatch",
          metadata: signedMeta(
            {
              email: "mismatch@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Mismatch User",
            },
            500,
          ),
          paymentIntent: "pi_item_mismatch",
          sessionId: "cs_item_mismatch",
        }),
        "re_mismatch",
      );

      // Signed by us → the booking is kept as a quantity-0 placeholder and
      // refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_item_mismatch",
        mockRefund,
      );
    });

    test("multi-ticket keeps and refunds when sum(p) does not equal amountTotal", async () => {
      await setupStripe();

      const listing = await createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
      });

      // p=2000 is valid for can_pay_more (>= 1000), but amountTotal=1500 != sum(p)=2000
      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1500,
          eventId: "evt_total_mismatch",
          metadata: signedMeta(
            {
              email: "total@example.com",
              items: JSON.stringify([{ e: listing.id, p: 2000, q: 1 }]),
              name: "Total Mismatch",
            },
            1500,
          ),
          paymentIntent: "pi_total_mismatch",
          sessionId: "cs_total_mismatch",
        }),
        "re_total",
      );

      // Signed by us → the booking is kept as a quantity-0 placeholder and
      // refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_total_mismatch",
        mockRefund,
      );
    });
  },
);
