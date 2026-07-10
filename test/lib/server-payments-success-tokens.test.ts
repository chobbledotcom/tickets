import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import {
  expectHtmlResponse,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { signMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
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
