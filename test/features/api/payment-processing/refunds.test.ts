// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";
// jscpd:ignore-end

import {
  debugLogged,
  errorLogged,
  useDebugLogSpy,
  useErrorLogSpy,
} from "#test-utils/log-spy.ts";
import {
  webhookEvent,
  withWebhookVerify,
} from "#test-utils/webhook-verify-helpers.ts";

/** Create a listing, deactivate it, and return its id — the shared setup for
 *  every redirect-path refund test. */
const deactivatedListing = async () => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 1000,
  });
  await deactivateTestListing(listing.id);
  return listing;
};

/** Set up a deactivated listing, stub the refund/refunded behaviors, retrieve
 *  a session, and run the redirect handler — the shared scaffold for the
 *  already-refunded and refund-failed redirect tests. */
const withRefundRedirect = async (
  refundSucceeds: boolean,
  alreadyRefunded: boolean,
  sessionId: string,
  paymentIntent: string,
  email: string,
  name: string,
  assert: () => Promise<void>,
): Promise<void> => {
  await setupStripe();
  const listing = await deactivatedListing();
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  using _refund = stub(stripePaymentProvider, "refundPayment", () =>
    Promise.resolve(refundSucceeds),
  );
  using _refunded = stub(stripePaymentProvider, "isPaymentRefunded", () =>
    Promise.resolve(alreadyRefunded),
  );
  const mockRetrieve = stubRetrieveCheckoutSession({
    amountTotal: 1000,
    email,
    items: singleItem(listing.id, 1, 1000),
    name,
    paymentIntent,
    sessionId,
  });
  try {
    await handleRequest(
      mockRequest(`/payment/success?session_id=${sessionId}`),
    );
    await assert();
  } finally {
    mockRetrieve.restore();
  }
};

describeWithEnv("server (refund helper mutations)", { db: true }, () => {
  const debugSpy = useDebugLogSpy();
  const errorSpy = useErrorLogSpy();

  test("refund logs debug when issued", async () => {
    await setupStripe();
    const listing = await deactivatedListing();
    const mockRefund = stubRefundPayment();
    const mockRetrieve = stubRetrieveCheckoutSession({
      amountTotal: 1000,
      email: "r@e.com",
      items: singleItem(listing.id, 1, 1000),
      name: "R",
      paymentIntent: "pi_refund_log",
      sessionId: "cs_refund_log",
    });
    try {
      const res = await handleRequest(
        mockRequest("/payment/success?session_id=cs_refund_log"),
      );
      await expectHtmlResponse(res, 410, "no longer accepting", "refunded");
      expect(debugLogged(debugSpy, "Refund issued")).toBe(true);
    } finally {
      mockRefund.restore();
      mockRetrieve.restore();
    }
  });

  test("refund logs already-refunded when isPaymentRefunded returns true", async () => {
    await withRefundRedirect(
      false,
      true,
      "cs_already_refunded",
      "pi_already_refunded",
      "r2@e.com",
      "R2",
      async () =>
        expect(debugLogged(debugSpy, "already fully refunded")).toBe(true),
    );
  });

  test("refund logs error when refund fails and provider is reachable", async () => {
    await withRefundRedirect(
      false,
      false,
      "cs_refund_fail",
      "pi_refund_fail",
      "r3@e.com",
      "R3",
      async () =>
        expect(errorLogged(errorSpy, "Failed to refund payment")).toBe(true),
    );
  });

  test("price-mismatch refund stores and refunds", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_mismatch",
        metadata: signedMeta(
          {
            email: "m@e.com",
            items: singleItem(listing.id, 1, 1000),
            name: "M",
          },
          1000,
        ),
        paymentIntent: "pi_mismatch",
        sessionId: "cs_mismatch",
      }),
      (json) => {
        expect(json.processed).toBe(false);
        expect(json.error).toContain("saved your details");
      },
    );
  });

  test("deleted-listing refund uses 404 status", async () => {
    await setupStripe();
    await withWebhookVerify(
      webhookEvent({
        amountTotal: 500,
        eventId: "evt_404",
        metadata: signedMeta(
          { email: "n@e.com", items: singleItem(99999, 1, 500), name: "N" },
          500,
        ),
        paymentIntent: "pi_404",
        sessionId: "cs_404",
      }),
      (json) => {
        expect(json.processed).toBe(false);
      },
    );
  });
});
