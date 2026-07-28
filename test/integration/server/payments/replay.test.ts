// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getNoteRows } from "#shared/db/notes/queries.ts";
import { isSessionProcessed } from "#shared/db/processed-payments.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  // A handled post-payment failure reserves the session, then refunds/returns.
  // The reservation must record the terminal outcome so an immediate retry
  // (redirect refresh or webhook re-delivery) replays the SAME result instead
  // of re-refunding or getting stuck behind the "being processed" lock.
  describe("GET /payment/success — idempotent replay of handled failures", () => {
    /** Stub a fixed paid + signed session plus a refund spy. Signing at
     * amountTotal (as production checkout does) classifies the session as
     * trusted — an unsigned session would be ignored. */
    const stubPaidSession = (
      sessionId: string,
      metadata: { email: string; items: string; name: string },
      amountTotal: number,
    ) => ({
      mockRefund: stubRefundPayment(),
      mockRetrieve: stubRetrieveCheckoutSession({
        amountTotal,
        email: metadata.email,
        items: metadata.items,
        name: metadata.name,
        paymentIntent: `pi_${sessionId}`,
        sessionId,
      }),
    });

    /** Assert a retry replays the same fully-handled "saved details" outcome:
     * HTTP 200, never the transient lock, and no second refund — then read
     * `countRemaining` AFTER the retry to prove it left exactly one surviving
     * booking (so a replay that adds an extra placeholder is caught). */
    const expectReplayedSave = async (
      sessionId: string,
      mockRefund: { calls: unknown[] },
      countRemaining: () => Promise<number>,
    ) => {
      const second = await handleRequest(
        mockRequest(`/payment/success?session_id=${sessionId}`),
      );
      expect(second.status).toBe(200);
      const html = await second.text();
      expect(html).toContain("saved your details");
      expect(html).not.toContain("being processed");
      expect(await countRemaining()).toBe(1);
      expect(mockRefund.calls.length).toBe(1);
    };

    test("closed-listing-after-payment refunds once and replays on retry", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await deactivateTestListing(listing.id);

      await withMocks(
        () =>
          stubPaidSession(
            "cs_replay_closed",
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "John",
            },
            1000,
          ),
        async ({ mockRefund }) => {
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_closed"),
          );
          await expectHtmlResponse(
            first,
            410,
            "no longer accepting registrations",
            "refunded",
          );

          const second = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_closed"),
          );
          expect(second.status).toBe(410);
          const html = await second.text();
          expect(html).toContain("no longer accepting registrations");
          expect(html).toContain("refunded");
          // The retry never shows the transient lock message...
          expect(html).not.toContain("being processed");
          // ...and never issues a second refund.
          expect(mockRefund.calls.length).toBe(1);
        },
      );
    });

    test("price-mismatch-after-payment is stored, refunded once, and replays on retry", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // Stale checkout: metadata price (500) no longer matches the listing's
      // current 1000, so the booking is kept and refunded once. A fully-handled
      // outcome renders with HTTP 200, and a retry replays it (no re-refund).
      await withMocks(
        () =>
          stubPaidSession(
            "cs_replay_price",
            {
              email: "john@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "John",
            },
            500,
          ),
        async ({ mockRefund }) => {
          // First delivery: the booking is kept as a quantity-0 placeholder and
          // refunded once. The specific reason now lives in the system note, so
          // the customer sees the generic saved-details message (HTTP 200).
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_replay_price"),
          );
          await expectHtmlResponse(first, 200, "saved your details");

          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(0);
          expect(
            (await getNoteRows("attendee", [attendees[0]!.id])).length,
          ).toBe(1);
          expect(mockRefund.calls.length).toBe(1);

          // The session is recorded as a terminal failure.
          const record = await isSessionProcessed("cs_replay_price");
          expect(record?.attendee_id).toBeNull();
          expect(record?.failure_data).not.toBe("");

          // Retry replays the same terminal outcome: same message, no second
          // placeholder, no second refund, never the transient lock message.
          await expectReplayedSave(
            "cs_replay_price",
            mockRefund,
            async () => (await getAttendeesRaw(listing.id)).length,
          );
        },
      );
    });

    test("a failed refund releases the reservation so the next retry re-attempts it", async () => {
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      await deactivateTestListing(listing.id);

      await withMocks(
        () => ({
          // The provider's refund call fails (e.g. transiently down) and the
          // payment is not already refunded, so the refund genuinely failed.
          mockRefund: stub(stripePaymentProvider, "refundPayment", () =>
            Promise.resolve(false),
          ),
          mockRefunded: stub(stripePaymentProvider, "isPaymentRefunded", () =>
            Promise.resolve(false),
          ),
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 1000,
            email: "john@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "John",
            paymentIntent: "pi_refund_failed",
            sessionId: "cs_refund_failed",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_refund_failed"),
          );
          expect(mockRefund.calls.length).toBe(1);
          expect(await response.text()).toContain("contact support");
          // The failure is NOT frozen as terminal AND the reservation is not
          // left held: the row is released (deleted) so the next delivery
          // re-claims and re-attempts the refund immediately, rather than
          // colliding with the lock until the row goes stale.
          expect(await isSessionProcessed("cs_refund_failed")).toBeNull();

          // The next retry re-attempts the refund (proof the lock was released).
          await handleRequest(
            mockRequest("/payment/success?session_id=cs_refund_failed"),
          );
          expect(mockRefund.calls.length).toBe(2);
        },
      );
    });
  });
});
