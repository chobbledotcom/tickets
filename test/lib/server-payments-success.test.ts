import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  bookAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  mockRequest,
  setTestEnv,
  setupStripe,
  signMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes ticket payment success", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Success Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2500,
          id: "cs_multi_success",
          metadata: signMeta(
            {
              email: "multi@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 2000, q: 2 },
              ]),
              name: "Multi Payer",
            },
            2500,
          ),
          payment_intent: "pi_multi_success",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_success"),
        );
        // With multi-listing attendees, one token covers all listings
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "Thank you for your order",
          "Click here to view your ticket",
        );

        // Verify attendees created for both listings
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(listing1.id);
        const attendees2 = await getAttendeesRaw(listing2.id);
        expect(attendees1.length).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns error for invalid ticket metadata", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_bad_multi",
          metadata: {
            email: "bad@example.com",

            items: "not-an-array",
            name: "Bad",
          },
          payment_intent: "pi_bad",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_bad_multi"),
        );
        // No valid proof (unsigned, and the items don't parse) → ignored.
        await expectHtmlResponse(response, 400, "not recognized");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("skips refund for ticket payment when listing not found", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_notfound",
          metadata: {
            email: "missing@example.com",

            items: JSON.stringify([{ e: 99999, p: 500, q: 1 }]),
            name: "Missing Listing",
          },
          payment_intent: "pi_multi_notfound",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = spy(stripeApi, "refundPayment");

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_notfound"),
        );
        // Unsigned → ignored as not ours: not-recognized page, never refunded
        // (the session may belong to a different instance sharing the provider).
        await expectHtmlResponse(response, 400, "not recognized");
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("refunds ticket payment when listing is inactive", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Multi Inactive Pay",
        unitPrice: 500,
      });
      await deactivateTestListing(listing.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_multi_inactive",
          metadata: signMeta(
            {
              email: "inactive@example.com",
              items: JSON.stringify([{ e: listing.id, p: 500, q: 1 }]),
              name: "Inactive Listing",
            },
            500,
          ),
          payment_intent: "pi_multi_inactive",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_inactive_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_inactive"),
        );
        await expectHtmlResponse(
          response,
          410,
          "no longer accepting registrations",
          "refunded",
        );
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows refund failure message when refund fails", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the listing
      await bookAttendee(listing, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_refund_fail",
          metadata: signMeta(
            {
              email: "refund@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Refund Fail",
            },
            1000,
          ),
          payment_intent: "pi_refund_fail",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      // Mock refund to fail, and the payment is not already refunded, so the
      // refund genuinely failed (→ contact-support, not an idempotent success).
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );
      const mockIntent = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve({
          latest_charge: { refunded: false },
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrievePaymentIntent>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        // Kept as a quantity-0 placeholder; the refund FAILED, so the customer is
        // told their details are saved and the refund is being arranged (HTTP 200).
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refund is being arranged",
        );
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        const ghost = (await getAttendeesRaw(listing.id)).find(
          (a) => a.quantity === 0,
        );
        expect(ghost).toBeDefined();
        expect(await getNoteRows([ghost!.id])).toHaveLength(1);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
        mockIntent.restore();
      }
    });

    test("ticket payment capacity failure is kept as a placeholder and refunded", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Rollback 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi Rollback 2",
        unitPrice: 1000,
      });

      // Fill listing2
      await bookAttendee(listing2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_rollback",
          metadata: signMeta(
            {
              email: "rollback@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Rollback User",
            },
            1500,
          ),
          payment_intent: "pi_multi_rollback",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_rollback_refund" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        // The capacity failure no longer drops the booking: it's kept as a
        // quantity-0 placeholder across BOTH listings and refunded (HTTP 200).
        await expectHtmlResponse(
          response,
          200,
          "saved your details",
          "refunded",
        );

        // The paid customer is never lost: a quantity-0 ghost is kept on listing1
        // (not rolled back to nothing).
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const ghost1 = (await getAttendeesRaw(listing1.id)).find(
          (a) => a.quantity === 0,
        );
        expect(ghost1).toBeDefined();
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_thankyou",
          metadata: signMeta(
            {
              email: "single@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Single",
            },
            500,
          ),
          payment_intent: "pi_single_thankyou",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_single_thankyou"),
        );
        expect(redirectResponse.status).toBe(302);
        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "https://example.com/single-thanks",
          "Click here to view your ticket",
        );
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_dupe_session",
          metadata: signMeta(
            {
              email: "dupe@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Dupe",
            },
            1000,
          ),
          payment_intent: "pi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_dupe_session"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");

        // Should still only have one attendee
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles single-item cart session replay (shows thank_you_url)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_cart_single",
          metadata: signMeta(
            {
              email: "cartsingle@example.com",
              items: JSON.stringify([{ e: listing.id, p: 800, q: 1 }]),
              name: "Cart Single Buyer",
            },
            800,
          ),
          payment_intent: "pi_cart_single",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request: process and redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response1.status).toBe(302);

        // Follow redirect to render success page with tokens
        const tokenResponse = await followRedirect(response1, handleRequest);
        const tokenHtml = await tokenResponse.text();
        // Single-listing cart: token path resolves one unique listing → shows thank_you_url
        expect(tokenHtml).toContain("redirected");

        // Replay (no tokens stored): renders directly via items.length === 1 branch
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_cart_single"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
        // Single-item cart replay also shows thank_you_url
        expect(html).toContain("redirected");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles ticket duplicate session replay (already processed)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Replay Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_dupe",
          metadata: signMeta(
            {
              email: "multireplay@example.com",
              items: JSON.stringify([
                { e: listing1.id, p: 500, q: 1 },
                { e: listing2.id, p: 1000, q: 1 },
              ]),
              name: "Multi Replay",
            },
            1500,
          ),
          payment_intent: "pi_multi_dupe",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // First request should redirect with tokens
        const response1 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response1.status).toBe(302);

        // Second request (replay) renders directly — redirect path doesn't store tokens,
        // so replay has no tokens to redirect with
        const response2 = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_dupe"),
        );
        expect(response2.status).toBe(200);
        const html = await response2.text();
        expect(html).toContain("Thank you for your order");
      } finally {
        mockRetrieve.restore();
      }
    });
  });

  describe("payment success token verification", () => {
    test("returns error for tokens param with only delimiters", async () => {
      // %2B decodes to "+", parseTokens produces empty array, no tokens to verify
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=%2B"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for empty tokens param", async () => {
      // Empty string is falsy → falls through to final error
      const response = await handleRequest(
        mockRequest("/payment/success?tokens="),
      );
      expect(response.status).toBe(400);
    });

    test("returns error for invalid tokens not in database", async () => {
      const response = await handleRequest(
        mockRequest("/payment/success?tokens=nonexistent_token"),
      );
      expect(response.status).toBe(400);
    });

    test("returns error when no session_id or tokens param", async () => {
      const response = await handleRequest(mockRequest("/payment/success"));
      expect(response.status).toBe(400);
    });

    test("renders ticket link from verified tokens", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/verified-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_token_verify",
          metadata: signMeta(
            {
              email: "verify@example.com",
              items: singleItem(listing.id, 1, 500),
              name: "Token Verify",
            },
            500,
          ),
          payment_intent: "pi_token_verify",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      try {
        // Process payment to get redirect with token
        const redirectResponse = await handleRequest(
          mockRequest("/payment/success?session_id=cs_token_verify"),
        );
        const location = expectRedirect(redirectResponse);

        // Follow redirect to verify tokens and render page
        const response = await followRedirect(redirectResponse, handleRequest);
        expect(response.status).toBe(200);
        const html = await response.text();

        // Should have ticket link with verified token
        expect(html).toContain("Click here to view your ticket");
        expect(html).toContain('target="_blank"');
        expect(html).toContain("/t/");

        // Should have thank_you_url for single-listing purchase
        expect(html).toContain("https://example.com/verified-thanks");

        // Token in the link should match the one in the redirect URL
        const tokenFromUrl = decodeURIComponent(location.split("tokens=")[1]!);
        expect(html).toContain(`/t/${tokenFromUrl}`);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("shows email notice on payment success when email configured", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Create attendee directly (simulates post-payment state)
      const result = await bookAttendee(listing, {
        email: "buyer@example.com",
        name: "Email Test",
        paymentId: "pi_email_notice",
        pricePaid: 500,
      });
      if (!result.success) throw new Error("Failed to create attendee");

      const restore = setTestEnv({
        HOST_EMAIL_API_KEY: "re_test123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@tickets.com",
        HOST_EMAIL_PROVIDER: "resend",
      });

      try {
        const response = await handleRequest(
          mockRequest(
            `/payment/success?tokens=${encodeURIComponent(
              result.attendees[0]!.ticket_token,
            )}`,
          ),
        );
        const html = await expectHtmlResponse(response, 200, "Junk/Spam");
        expect(html).toContain("noreply@tickets.com");
      } finally {
        restore();
      }
    });
  });
});
