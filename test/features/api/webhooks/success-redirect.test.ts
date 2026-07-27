import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  createSoldOutListing,
  routedResponse,
  stubRetrieveSession,
} from "./helpers.ts";

describeWithEnv("payment success redirect", { db: true }, () => {
  const errors = setupErrorSpy();

  const expectPaidSessionParam = async (
    param: "session_id" | "orderId",
    sessionId: string,
    paymentIntent: string,
    listing: { id: number },
  ): Promise<void> => {
    const retrieve = await stubRetrieveSession(
      sessionId,
      paymentIntent,
      listing,
      1000,
      { thank_you_url: "https://example.com/thanks" },
    );
    try {
      const response = await routedResponse(
        mockRequest(`/payment/success?${param}=${sessionId}`),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data-payment-result="success"');
    } finally {
      retrieve.restore();
    }
  };

  test("renders paid success for a session_id redirect", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
      unitPrice: 1000,
    });

    await expectPaidSessionParam("session_id", "cs_paid", "pi_test", listing);
  });

  test("uses orderId when session_id is absent", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
      unitPrice: 1000,
    });

    await expectPaidSessionParam(
      "orderId",
      "cs_order_param",
      "pi_order_param",
      listing,
    );
  });

  test("preserves the explicit thank-you URL on a repeat redirect", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/listing-thanks",
      unitPrice: 1000,
    });
    const retrieve = await stubRetrieveSession(
      "cs_processed",
      "pi_processed",
      listing,
      1000,
      { thank_you_url: "https://example.com/explicit-thanks" },
    );

    try {
      const first = await routedResponse(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      expect(first.status).toBe(200);
      const firstHtml = await first.text();
      expect(firstHtml).toContain("https://example.com/explicit-thanks");
      expect(firstHtml).toContain('data-payment-result="success"');
      const second = await routedResponse(
        mockRequest("/payment/success?session_id=cs_processed"),
      );
      expect(second.status).toBe(200);
      const secondHtml = await second.text();
      expect(secondHtml).toContain("https://example.com/explicit-thanks");
      expect(secondHtml).toContain('data-payment-result="success"');
    } finally {
      retrieve.restore();
    }
  });

  test("logs the first listing id when redirect processing fails", async () => {
    await setupStripe();
    const listing = await createSoldOutListing();
    const retrieve = await stubRetrieveSession(
      "cs_fail_log",
      "pi_fail_log",
      listing,
      1000,
    );

    try {
      const response = await routedResponse(
        mockRequest("/payment/success?session_id=cs_fail_log"),
      );
      expect(response.status).toBe(200);
      expect(errors.contains(`listing=${listing.id}`)).toBe(true);
    } finally {
      retrieve.restore();
    }
  });
});
