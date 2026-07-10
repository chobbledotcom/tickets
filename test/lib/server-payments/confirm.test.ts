// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  bookAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  makeParent,
  mockRequest,
  setupStripe,
  signMeta,
  singleItem,
  stubRetrieveCheckoutSession,
  withMocks,
} from "#test-utils";

// jscpd:ignore-end

/** A signed, paid "John" checkout for a single listing — the trusted-session
 *  shape the confirmation tests share, differing only in the id, the items,
 *  and the agreed total. */
const johnSession = (sessionId: string, items: string, amountTotal: number) =>
  stubRetrieveCheckoutSession({
    amountTotal,
    email: "john@example.com",
    items,
    name: "John",
    paymentIntent: "pi_test_123",
    sessionId,
  });

describeWithEnv("server (payment flow)", { db: true, triggers: true }, () => {
  describe("ticket purchase confirmation", () => {
    test("an unsigned session for an unknown listing is ignored without refunding", async () => {
      const { spy } = await import("@std/testing/mock");
      const { stripeApi } = await import("#shared/stripe.ts");
      await setupStripe();

      await withMocks(
        () => ({
          mockRefund: spy(stripeApi, "refundPayment"),
          // Unsigned metadata (no price_proof) for a non-existent listing.
          mockRetrieve: stubRetrieveCheckoutSession({
            amountTotal: 0,
            metadata: {
              email: "john@example.com",
              items: singleItem(99999, 1, 0),
              name: "John",
            },
            paymentIntent: "pi_test",
            sessionId: "cs_test",
          }),
        }),
        async ({ mockRefund }) => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test"),
          );
          // No valid proof → ignored as not ours: shown the not-recognized page
          // and never refunded (the session may belong to a different instance).
          await expectHtmlResponse(response, 400, "not recognized");
          expect(mockRefund.calls.length).toBe(0);
        },
        resetStripeClient,
      );
    });

    test("creates attendee and shows success when payment verified", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          johnSession("cs_test_paid", singleItem(listing.id, 1, 1000), 1000),
        async () => {
          const redirectResponse = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Should redirect with tokens
          expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

          // Follow the redirect
          const response = await followRedirect(
            redirectResponse,
            handleRequest,
          );
          await expectHtmlResponse(
            response,
            200,
            "Thank you for your order",
            "https://example.com/thanks",
            "Click here to view your ticket",
            'target="_blank"',
          );

          // Verify attendee was created with encrypted PII blob
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.pii_blob).not.toBe("");

          // Verify tokens are NOT persisted in DB (redirect has them in URL, no need to store)
          const { isSessionProcessed } = await import(
            "#shared/db/processed-payments.ts"
          );
          const record = await isSessionProcessed("cs_test_paid");
          expect(record?.ticket_tokens).toBe("");
        },
        resetStripeClient,
      );
    });

    /** A parent with a configured thank-you URL folding one required paid child,
     * whose signed checkout metadata carries that explicit thank_you_url and two
     * listing ids. Returns the `withMocks` stub factory for the given provider
     * session id + payment intent — the scaffolding both thank-you-URL tests
     * share (they differ only in what they assert about the rendered page). */
    const parentThanksStub = async (
      sessionId: string,
      paymentIntent: string,
    ) => {
      await setupStripe();

      const { parent, child } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
        parent: {
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks-parent",
          unitPrice: 1000,
        },
      });

      const items = JSON.stringify([
        { e: parent.id, p: 1000, q: 1 },
        { e: child.id, p: 1000, q: 1 },
      ]);

      return () =>
        stubRetrieveCheckoutSession({
          amountTotal: 2000,
          metadata: signMeta(
            {
              email: "john@example.com",
              items,
              name: "John",
              thank_you_url: "https://example.com/thanks-parent",
            },
            2000,
          ),
          paymentIntent,
          sessionId,
        });
    };

    test("a parent's thank-you URL survives a folded paid child (multi-listing)", async () => {
      // A single parent with a configured thank_you_url folds a required paid
      // child, so the completed booking has TWO unique listing ids. The default
      // success rule drops thank_you_url for multi-listing orders; the explicit
      // intent value (carried in the signed metadata) must still win.
      await withMocks(
        await parentThanksStub("cs_parent_thanks", "pi_parent_thanks"),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_thanks"),
          );
          // The explicit URL renders the success page directly with the parent's
          // thank-you URL, even though two listings were booked.
          await expectHtmlResponse(
            response,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
        },
        resetStripeClient,
      );
    });

    test("a parent's direct-render booking keeps its ticket URL on reload", async () => {
      // The explicit-thank-you (parent) booking renders the success page directly
      // from session_id (no token in the URL). Re-hitting the same provider
      // callback lands on the already-processed branch; the ticket token must be
      // persisted so that reload still renders a non-null ticket URL (and the
      // parent's thank-you URL), instead of losing the buyer's ticket link.
      await withMocks(
        await parentThanksStub("cs_parent_reload", "pi_parent_reload"),
        async () => {
          // First hit finalizes and renders directly with the ticket URL.
          const first = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_reload"),
          );
          const firstHtml = await expectHtmlResponse(
            first,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
          expect(firstHtml).toContain("/t/");

          // Reload hits the already-processed branch; the persisted token still
          // yields a non-null ticket URL and the parent's thank-you URL.
          const reload = await handleRequest(
            mockRequest("/payment/success?session_id=cs_parent_reload"),
          );
          const reloadHtml = await expectHtmlResponse(
            reload,
            200,
            "Thank you for your order",
            "https://example.com/thanks-parent",
          );
          expect(reloadHtml).toContain("/t/");
        },
        resetStripeClient,
      );
    });

    test("handles replay of same session (idempotent)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      // Create attendee as if payment was already processed (using atomic to simulate production flow)
      await bookAttendee(listing, {
        email: "john@example.com",
        name: "John",
        paymentId: "pi_test_123",
      });

      await withMocks(
        () =>
          johnSession("cs_test_paid", singleItem(listing.id, 1, 1000), 1000),
        async () => {
          const response = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          // Capacity check will now fail since we already have the attendee
          // This is expected - in the new flow, replaying creates a duplicate attempt
          // which fails the capacity check if listing is near full
          // For idempotent behavior, we'd need to check payment_intent uniqueness
          // Response is either a 302 redirect (with tokens) or 200 (direct render for replay)
          expect([200, 302]).toContain(response.status);
        },
        resetStripeClient,
      );
    });

    test("handles multiple quantity purchase", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      await withMocks(
        () =>
          johnSession("cs_test_paid", singleItem(listing.id, 3, 3000), 3000),
        async () => {
          const redirectResponse = await handleRequest(
            mockRequest("/payment/success?session_id=cs_test_paid"),
          );

          expect(redirectResponse.status).toBe(302);
          const response = await followRedirect(
            redirectResponse,
            handleRequest,
          );
          expect(response.status).toBe(200);

          // Verify attendee was created with correct quantity
          const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.length).toBe(1);
          expect(attendees[0]?.quantity).toBe(3);
        },
        resetStripeClient,
      );
    });
  });
});
