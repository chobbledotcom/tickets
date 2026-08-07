// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  joinedStubs,
  stubProviderPaymentAttempt,
} from "#test-utils/payment-attempt.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > SumUp", { db: true }, () => {
  /** Configure SumUp and stage a real checkout for the given listing:
   * production assembleCheckoutMetadata output, encrypted store, id mapping. */
  const stageSumupCheckout = async (listing: {
    id: number;
    name: string;
    slug: string;
  }) => {
    await settings.update.paymentProvider("sumup");
    await settings.update.sumup.apiKey("sk_test_x");
    await settings.update.sumup.merchantCode("MC1");
    setEffectiveDomainForTest("localhost");
    const reference = crypto.randomUUID();
    const intent: CheckoutIntent = {
      address: "",
      date: null,
      email: "alice@example.com",
      items: [
        {
          listingId: listing.id,
          name: listing.name,
          quantity: 1,
          slug: listing.slug,
          unitPrice: 1000,
        },
      ],
      name: "Alice",
      phone: "",
      special_instructions: "",
    };
    // Price once and sign that total, exactly as production checkout does.
    const metadata = await assembleCheckoutMetadata(
      "sumup",
      intent,
      priceCheckout(intent).total,
    );
    await storeSumupCheckout(reference, metadata);
    await setSumupCheckoutId(reference, "co_e2e");
    return reference;
  };

  /** Unsigned SumUp webhook listing for the staged checkout. */
  const sumupWebhookEvent = {
    event_type: "CHECKOUT_STATUS_CHANGED",
    id: "co_e2e",
  };

  /** Stub SumUp's checkout lookup for the staged `reference` with the given
   *  outcome — the end-to-end and cancel-page tests share everything but the
   *  status/transactionId. */
  const stubRetrieveCheckoutById = (
    reference: string,
    status: "FAILED" | "PAID",
    transactionId: string,
  ) => {
    const retrieve = stub(sumupApi, "retrieveCheckoutById", () =>
      Promise.resolve({
        amountMinor: 1000,
        currency: "GBP",
        reference,
        status,
        transactionId,
      }),
    );
    return joinedStubs(
      retrieve,
      stubProviderPaymentAttempt(sumupPaymentProvider),
    );
  };

  test("processes an unsigned SumUp webhook end to end, idempotently", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const reference = await stageSumupCheckout(listing);
    const restore = stubRetrieveCheckoutById(reference, "PAID", "txn_e2e");
    try {
      const response = await handleRequest(
        mockWebhookRequest(sumupWebhookEvent),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).processed).toBe(true);

      // A retried webhook resolves to the already-created attendee
      const retry = await handleRequest(mockWebhookRequest(sumupWebhookEvent));
      expect((await retry.json()).processed).toBe(true);
    } finally {
      restore.restore();
    }
  });

  test("acknowledges unknown SumUp checkout ids without fetching from the API", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageSumupCheckout(listing);
    const fetchStub = stub(sumupApi, "retrieveCheckoutById", () =>
      Promise.resolve(null),
    );
    const attempt = stubProviderPaymentAttempt(sumupPaymentProvider);
    try {
      const response = await handleRequest(
        mockWebhookRequest({
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: "co_spam",
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).received).toBe(true);
      expect(fetchStub.calls.length).toBe(0);
    } finally {
      fetchStub.restore();
      attempt.restore();
    }
  });

  test("shows the cancel page when a SumUp payment fails", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const reference = await stageSumupCheckout(listing);
    const restore = stubRetrieveCheckoutById(reference, "FAILED", "");
    try {
      const response = await handleRequest(
        mockRequest(`/payment/success?session_id=${reference}`),
      );
      await expectHtmlResponse(response, 200, "Payment Cancelled");
    } finally {
      restore.restore();
    }
  });
});
