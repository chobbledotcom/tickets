// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { queryAll } from "#shared/db/client.ts";
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
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  chargeMoney,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";

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
    currency = "GBP",
  ) =>
    stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        resource: {
          amountMinor: 1000,
          currency,
          reference,
          status,
          transactionId,
        },
        status: "found" as const,
      }));

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

  /** POST an unsigned callback for `id` and expect the fixed refusal with no
   * SumUp fetch — the shared contract for every id refused locally. Its body
   * never says why verification failed, and the payload is never echoed into
   * a log or acknowledged. */
  const expectRefusedLocally = async (id: string) => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await stageSumupCheckout(listing);
    const fetchStub = stub(
      sumupApi,
      "readCheckoutById",
      () => Promise.resolve({ status: "missing" as const }),
    );
    try {
      const response = await handleRequest(
        mockWebhookRequest({ event_type: "CHECKOUT_STATUS_CHANGED", id }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(await response.text()).toBe("Payment verification failed");
      expect(fetchStub.calls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
  };

  test("refuses an oversized SumUp checkout id with the fixed response", () =>
    expectRefusedLocally("x".repeat(256)));

  test("refuses unknown SumUp checkout ids retryably without fetching from the API", () =>
    // The same refusal covers a real callback racing our staging write.
    expectRefusedLocally("co_spam"));

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

  /** Keep the provider's charge observation stale until the test makes the
   * returned money visible. The real SumUp adapter still performs the send. */
  const installRefundObservation = (
    returned: () => boolean,
  ) => ({
    read: stub(sumupPaymentProvider, "readCharge", () =>
      Promise.resolve(
        foundCharge(returned() ? fullyRefundedMoney() : chargeMoney()),
      )),
    send: stub(
      sumupApi,
      "refundTransaction",
      () => Promise.resolve({ kind: "sent" as const }),
    ),
  });

  /** A callback for a staged checkout. */
  const postSumupWebhook = (): Promise<Response> =>
    handleRequest(mockWebhookRequest(sumupWebhookEvent));

  test("does not send a rejected SumUp charge twice while its first refund is not yet visible", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const reference = await stageSumupCheckout(listing);
    const checkout = stubRetrieveCheckoutById(
      reference,
      "PAID",
      "txn_rejected_once",
      "GB",
    );
    let returned = false;
    const refund = installRefundObservation(() => returned);
    try {
      expect((await postSumupWebhook()).status).toBe(503);
      expect((await postSumupWebhook()).status).toBe(503);
      expect(refund.send.calls).toHaveLength(1);

      returned = true;
      expect((await postSumupWebhook()).status).toBe(200);
      expect(refund.send.calls).toHaveLength(1);
    } finally {
      refund.send.restore();
      refund.read.restore();
      checkout.restore();
    }
  });

  test("does not release a reserved failed booking into a second SumUp refund", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    await deactivateTestListing(listing.id);
    const reference = await stageSumupCheckout(listing);
    const checkout = stubRetrieveCheckoutById(
      reference,
      "PAID",
      "txn_reserved_once",
    );
    let returned = false;
    const refund = installRefundObservation(() => returned);
    try {
      expect((await postSumupWebhook()).status).toBe(503);
      expect((await postSumupWebhook()).status).toBe(503);
      expect(refund.send.calls).toHaveLength(1);

      returned = true;
      expect((await postSumupWebhook()).status).toBe(200);
      expect(refund.send.calls).toHaveLength(1);
    } finally {
      refund.send.restore();
      refund.read.restore();
      checkout.restore();
    }
  });

  test("shares one SumUp refund between a browser return and webhook", async () => {
    const listing = await createTestListing({ unitPrice: 1000 });
    const reference = await stageSumupCheckout(listing);
    const checkout = stubRetrieveCheckoutById(
      reference,
      "PAID",
      "txn_callback_race",
      "GB",
    );
    const refund = installRefundObservation(() => false);
    try {
      const [browser, webhook] = await Promise.all([
        handleRequest(
          mockRequest(`/payment/success?session_id=${reference}`),
        ),
        postSumupWebhook(),
      ]);
      expect([browser.status, webhook.status]).toEqual([503, 503]);
      expect(refund.send.calls).toHaveLength(1);
      expect(
        await queryAll<{
          refund_revision: number;
          refund_state_name: string;
        }>(
          "SELECT refund_revision, refund_state_name FROM payment_charges",
        ),
      ).toEqual([{ refund_revision: 3, refund_state_name: "observing" }]);
    } finally {
      refund.send.restore();
      refund.read.restore();
      checkout.restore();
    }
  });

  for (
    const [name, providerCallLanded] of [
      ["before its provider call", false],
      ["after its provider call", true],
    ] as const
  ) {
    test(`does not repeat a keyless refund after crashing ${name}`, async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const reference = await stageSumupCheckout(listing);
      const checkout = stubRetrieveCheckoutById(
        reference,
        "PAID",
        `txn_crash_${providerCallLanded}`,
        "GB",
      );
      let returned = false;
      let attempts = 0;
      let providerCalls = 0;
      const read = stub(
        sumupPaymentProvider,
        "readCharge",
        () =>
          Promise.resolve(
            foundCharge(returned ? fullyRefundedMoney() : chargeMoney()),
          ),
      );
      const refund = stub(sumupPaymentProvider, "refundCharge", () => {
        attempts += 1;
        if (providerCallLanded) providerCalls += 1;
        if (attempts === 1) {
          throw new Error(`simulated crash ${name}`);
        }
        return Promise.resolve({
          kind: "uncertain" as const,
          reason: "network_error" as const,
        });
      });
      try {
        await expect(postSumupWebhook()).rejects.toThrow(
          `simulated crash ${name}`,
        );
        expect((await postSumupWebhook()).status).toBe(503);
        expect(attempts).toBe(1);
        expect(providerCalls).toBe(providerCallLanded ? 1 : 0);

        returned = true;
        expect((await postSumupWebhook()).status).toBe(200);
        expect(attempts).toBe(1);
      } finally {
        refund.restore();
        read.restore();
        checkout.restore();
      }
    });
  }
});
