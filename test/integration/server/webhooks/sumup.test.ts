// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { toBookingIntent } from "#shared/payment-helpers.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { sumupApi } from "#shared/sumup.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > SumUp", { db: true }, () => {
  /** Configure SumUp and store a real current payment for the given listing. */
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
    const account = await resolvePaymentAccount("sumup");
    await createPaymentSession({
      accountId: account.accountId,
      bookingIntent: await toBookingIntent(intent),
      checkoutCreate: null,
      expected: {
        amount: priceCheckout(intent).total,
        currency: settings.currency.toUpperCase(),
      },
      id: reference,
      mode: account.mode,
      provider: "sumup",
      session: {
        id: "co_e2e",
        kind: "sumup_checkout",
        provider: "sumup",
      },
    });
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
    transactionId?: string,
  ) => {
    const checkout = stub(sumupApi, "retrieveCheckoutById", () =>
      Promise.resolve({
        status: "found" as const,
        value: {
          amountMinor: 1000,
          createdAt: "2026-07-26T12:00:00.000Z",
          currency: "GBP",
          id: "co_e2e",
          merchantCode: "MC1",
          reference,
          status,
          ...(transactionId === undefined ? {} : { transactionId }),
        },
      }),
    );
    const transaction =
      transactionId === undefined
        ? null
        : stub(sumupApi, "getTransactionStatus", () =>
            Promise.resolve({
              status: "found" as const,
              value: {
                amount: { amount: 1000, currency: "GBP" },
                id: transactionId,
                merchantCode: "MC1",
                refunded: { amount: 0, currency: "GBP" },
                refunds: [],
                status: "SUCCESSFUL" as const,
                timestamp: "2026-07-26T12:01:00.000Z",
              },
            }),
          );
    return {
      restore: () => {
        transaction?.restore();
        checkout.restore();
      },
    };
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

  test("acknowledges an unavailable unknown SumUp checkout", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageSumupCheckout(listing);
    const fetchStub = stub(sumupApi, "retrieveCheckoutById", () =>
      Promise.resolve({ status: "unavailable" as const }),
    );
    try {
      const response = await handleRequest(
        mockWebhookRequest({
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: "co_spam",
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).received).toBe(true);
      expect(fetchStub.calls.length).toBe(1);
    } finally {
      fetchStub.restore();
    }
  });

  test("shows the cancel page when a SumUp payment fails", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const reference = await stageSumupCheckout(listing);
    const restore = stubRetrieveCheckoutById(reference, "FAILED");
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
