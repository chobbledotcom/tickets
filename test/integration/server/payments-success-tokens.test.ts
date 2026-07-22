import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { renderPaymentSuccess } from "#test/lib/payment-success-helpers.ts";
import { expectHtmlResponse, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
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
      await expectHtmlResponse(response, 400, "Invalid payment callback");
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
      await expectHtmlResponse(response, 400, "Invalid payment callback");
    });

    test("returns error when no session_id or tokens param", async () => {
      const errorLog = spy(console, "error");
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?foo=1&bar=2", {
            headers: { referer: "https://example.com/pay" },
          }),
        );
        await expectHtmlResponse(response, 400, "Invalid payment callback");
        expect(
          errorLog.calls.map((call) => call.args.join(" ")).join("\n"),
        ).toContain("params=[foo,bar] referer=https://example.com/pay");
      } finally {
        errorLog.restore();
      }
    });

    test("logs missing callback details when there are no query params or referer", async () => {
      const errorLog = spy(console, "error");
      try {
        const response = await handleRequest(mockRequest("/payment/success"));
        await expectHtmlResponse(response, 400, "Invalid payment callback");
        expect(
          errorLog.calls.map((call) => call.args.join(" ")).join("\n"),
        ).toContain("params=[none] referer=none");
      } finally {
        errorLog.restore();
      }
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
        // Process payment to get redirect with token, then render the page
        const { redirectResponse, response, html } =
          await renderPaymentSuccess("cs_token_verify");
        const location = expectRedirect(redirectResponse);
        expect(response.status).toBe(200);
        expect(html).toContain('data-payment-result="success"');

        // Should have ticket link with verified token
        expect(html).toContain("View your ticket");
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

    test("joins every verified token in the ticket link", async () => {
      const firstListing = await createTestListing({ unitPrice: 500 });
      const secondListing = await createTestListing({ unitPrice: 500 });
      const first = await bookAttendee(firstListing, {
        name: "First token",
        paymentId: "pi_first_token",
        pricePaid: 500,
      });
      const second = await bookAttendee(secondListing, {
        name: "Second token",
        paymentId: "pi_second_token",
        pricePaid: 500,
      });
      if (!first.success || !second.success) throw new Error("Booking failed");
      const tokens = [
        first.attendees[0]!.ticket_token,
        second.attendees[0]!.ticket_token,
      ];
      const response = await handleRequest(
        mockRequest(
          `/payment/success?tokens=${encodeURIComponent(tokens.join("+"))}`,
        ),
      );
      const html = await expectHtmlResponse(response, 200, "View your ticket");
      expect(html).toContain(`href="/t/${tokens.join("+")}"`);
      expect(html).not.toContain("mutated");
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

      using _env = withEnv({
        HOST_EMAIL_API_KEY: "re_test123",
        HOST_EMAIL_FROM_ADDRESS: "noreply@tickets.com",
        HOST_EMAIL_PROVIDER: "resend",
      });

      const response = await handleRequest(
        mockRequest(
          `/payment/success?tokens=${encodeURIComponent(
            result.attendees[0]!.ticket_token,
          )}`,
        ),
      );
      const html = await expectHtmlResponse(response, 200, "Junk/Spam");
      expect(html).toContain("noreply@tickets.com");
      expect(html).not.toContain("mutated");
    });
  });
});
