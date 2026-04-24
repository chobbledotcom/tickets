import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { resetStripeClient, stripeApi } from "#lib/stripe.ts";
import { handleRequest } from "#routes";
import {
  bookAttendee,
  createTestEvent,
  deactivateTestEvent,
  describeWithEnv,
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
  mockRequest,
  setTestEnv,
  setupStripe,
  singleItem,
} from "#test-utils";

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("processes ticket payment success", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Success Multi 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        name: "Success Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 2500,
          id: "cs_multi_success",
          metadata: {
            email: "multi@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 2000, q: 2 },
            ]),
            name: "Multi Payer",
          },
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
        // With multi-event attendees, one token covers all events
        expectRedirect(redirectResponse, /^\/payment\/success\?tokens=.+$/);

        const response = await followRedirect(redirectResponse, handleRequest);
        await expectHtmlResponse(
          response,
          200,
          "Thank you for your order",
          "Click here to view your ticket",
        );

        // Verify attendees created for both events
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        const attendees2 = await getAttendeesRaw(event2.id);
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
        await expectHtmlResponse(response, 400, "Invalid session data");
      } finally {
        mockRetrieve.restore();
      }
    });

    test("skips refund for ticket payment when event not found", async () => {
      await setupStripe();

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_notfound",
          metadata: {
            email: "missing@example.com",

            items: JSON.stringify([{ e: 99999, p: 500, q: 1 }]),
            name: "Missing Event",
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
        await expectHtmlResponse(response, 404, "Event not found");
        // Event not found should NOT trigger a refund (webhook may be for a different instance)
        expect(mockRefund.calls.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("refunds ticket payment when event is inactive", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        name: "Multi Inactive Pay",
        unitPrice: 500,
      });
      await deactivateTestEvent(event.id);

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          id: "cs_multi_inactive",
          metadata: {
            email: "inactive@example.com",

            items: JSON.stringify([{ e: event.id, p: 500, q: 1 }]),
            name: "Inactive Event",
          },
          payment_intent: "pi_multi_inactive",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
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

      const event = await createTestEvent({
        maxAttendees: 1,
        unitPrice: 1000,
      });

      // Fill the event
      await bookAttendee(event, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_refund_fail",
          metadata: {
            email: "refund@example.com",
            items: singleItem(event.id, 1, 1000),
            name: "Refund Fail",
          },
          payment_intent: "pi_refund_fail",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      // Mock refund to fail
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_refund_fail"),
        );
        await expectHtmlResponse(response, 409, "sold out", "contact support");
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("ticket payment sold out rolls back and refunds", async () => {
      await setupStripe();

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Multi Rollback 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 1,
        name: "Multi Rollback 2",
        unitPrice: 1000,
      });

      // Fill event2
      await bookAttendee(event2, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_rollback",
          metadata: {
            email: "rollback@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 1000, q: 1 },
            ]),
            name: "Rollback User",
          },
          payment_intent: "pi_multi_rollback",
          payment_status: "paid",
        } as unknown as Awaited<
          ReturnType<typeof stripeApi.retrieveCheckoutSession>
        >),
      );

      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_test" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_multi_rollback"),
        );
        await expectHtmlResponse(response, 409, "sold out", "refunded");

        // Verify rollback: event1 should have no attendees since they were rolled back
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees1 = await getAttendeesRaw(event1.id);
        expect(attendees1.length).toBe(0);
      } finally {
        mockRetrieve.restore();
        mockRefund.restore();
      }
    });

    test("shows thank_you_url for single-ticket success", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_single_thankyou",
          metadata: {
            email: "single@example.com",
            items: singleItem(event.id, 1, 500),
            name: "Single",
          },
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

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          id: "cs_dupe_session",
          metadata: {
            email: "dupe@example.com",
            items: singleItem(event.id, 1, 1000),
            name: "Dupe",
          },
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
        const { getAttendeesRaw } = await import("#lib/db/attendees.ts");
        const attendees = await getAttendeesRaw(event.id);
        expect(attendees.length).toBe(1);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("handles single-item cart session replay (shows thank_you_url)", async () => {
      await setupStripe();

      const event = await createTestEvent({
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 800,
          id: "cs_cart_single",
          metadata: {
            email: "cartsingle@example.com",

            items: JSON.stringify([{ e: event.id, p: 800, q: 1 }]),
            name: "Cart Single Buyer",
          },
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
        // Single-event cart: token path resolves one unique event → shows thank_you_url
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

      const event1 = await createTestEvent({
        maxAttendees: 50,
        name: "Replay Multi 1",
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        name: "Replay Multi 2",
        unitPrice: 1000,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1500,
          id: "cs_multi_dupe",
          metadata: {
            email: "multireplay@example.com",

            items: JSON.stringify([
              { e: event1.id, p: 500, q: 1 },
              { e: event2.id, p: 1000, q: 1 },
            ]),
            name: "Multi Replay",
          },
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

      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/verified-thanks",
        unitPrice: 500,
      });

      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 500,
          id: "cs_token_verify",
          metadata: {
            email: "verify@example.com",
            items: singleItem(event.id, 1, 500),
            name: "Token Verify",
          },
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

        // Should have thank_you_url for single-event purchase
        expect(html).toContain("https://example.com/verified-thanks");

        // Token in the link should match the one in the redirect URL
        const tokenFromUrl = decodeURIComponent(location.split("tokens=")[1]!);
        expect(html).toContain(`/t/${tokenFromUrl}`);
      } finally {
        mockRetrieve.restore();
      }
    });

    test("shows email notice on payment success when email configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });

      // Create attendee directly (simulates post-payment state)
      const result = await bookAttendee(event, {
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
