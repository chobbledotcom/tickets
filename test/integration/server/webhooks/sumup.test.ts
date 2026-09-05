// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { queryAll } from "#db/client.ts";
import { handleRequest } from "#routes";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import { logLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockRequest, mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  chargeMoney,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import {
  expectBookedExactlyOnce,
  stageSignedSumupCheckout,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

describeWithEnv("server webhooks > SumUp", { db: true }, () => {
  // The waiting page speaks through debug output, and a normal provider
  // state must not page the owner, so capture both channels.
  const errors = setupErrorSpy();
  const debugSpy = useDebugLogSpy();

  /** Stage a real, signed checkout mapped to the id the callbacks name, and
   * hand back the listing it was staged for — the tests that change the
   * listing have to change that one, not another. */
  const stageSumupCheckout = () => stageSignedSumupCheckout("co_e2e");

  /** Unsigned SumUp webhook listing for the staged checkout. */
  const sumupWebhookEvent = {
    event_type: "CHECKOUT_STATUS_CHANGED",
    id: "co_e2e",
  };

  /** Stub SumUp's checkout lookup for the staged `reference` with the given
   * outcome — the end-to-end and cancel-page tests share everything but the
   * status/transactionId. */
  const stubRetrieveCheckoutById = (
    reference: string,
    status: "FAILED" | "PAID" | "PENDING",
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
      }),
    );

  test("processes an unsigned SumUp webhook end to end, idempotently", async () => {
    const { reference } = await stageSumupCheckout();
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
    await stageSumupCheckout();
    const fetchStub = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({ status: "missing" as const }),
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
    const { reference } = await stageSumupCheckout();
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

  test("renders the waiting page when the return lands before payment confirms", async () => {
    const { reference } = await stageSumupCheckout();
    const restore = stubRetrieveCheckoutById(reference, "PENDING", "");
    try {
      const response = await handleRequest(
        mockRequest(`/payment/success?session_id=${reference}`),
      );

      expect(response.status).toBe(200);
      // The page's copy and link contract live with the classify and
      // template tests; this route-level leg proves the staged row opened,
      // the reload scheduled itself, and no error was paged.
      expect(await response.text()).toContain(
        "30;url=/payment/success?session_id=",
      );
      expect(logLogged(debugSpy, "not confirmed yet")).toBe(true);
      expect(errors.contains("E_PAYMENT_SESSION")).toBe(false);
    } finally {
      restore.restore();
    }
  });

  test("the same return books successfully once the callback completes it", async () => {
    const { reference } = await stageSumupCheckout();
    let status: "PAID" | "PENDING" = "PENDING";
    const restore = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        resource: {
          amountMinor: 1000,
          currency: "GBP",
          reference,
          status,
          transactionId: "txn_e2e",
        },
        status: "found" as const,
      }),
    );
    try {
      const waiting = await handleRequest(
        mockRequest(`/payment/success?session_id=${reference}`),
      );
      // Nothing booked yet: the payment is unconfirmed, so the buyer is
      // still waiting rather than holding a ticket.
      expect(waiting.status).toBe(200);
      expect(await waiting.text()).not.toContain(
        'data-payment-result="success"',
      );

      status = "PAID";
      const booked = await handleRequest(mockWebhookRequest(sumupWebhookEvent));
      expect((await booked.json()).processed).toBe(true);
      await expectBookedExactlyOnce();

      // Re-checking the exact same return now books for the browser: it
      // redirects to the ticket tokens and the success page behind them.
      const returned = await handleRequest(
        mockRequest(`/payment/success?session_id=${reference}`),
      );
      expect(returned.status).toBe(302);
      const tokensLocation = returned.headers.get("location") ?? "";
      expect(tokensLocation).toContain("/payment/success?tokens=");
      const success = await handleRequest(mockRequest(tokensLocation));
      expect(success.status).toBe(200);
      expect(await success.text()).toContain('data-payment-result="success"');
      await expectBookedExactlyOnce();
    } finally {
      restore.restore();
    }
  });

  /** Keep the provider's charge observation stale until the test makes the
   * returned money visible. The real SumUp adapter still performs the send. */
  const installRefundObservation = (returned: () => boolean) => ({
    read: stub(sumupPaymentProvider, "readCharge", () =>
      Promise.resolve(
        foundCharge(returned() ? fullyRefundedMoney() : chargeMoney()),
      ),
    ),
    send: stub(sumupApi, "refundTransaction", () =>
      Promise.resolve({ kind: "sent" as const }),
    ),
  });

  /** A callback for a staged checkout. */
  const postSumupWebhook = (): Promise<Response> =>
    handleRequest(mockWebhookRequest(sumupWebhookEvent));

  const expectOneRefundAcrossRetries = async (
    reference: string,
    transactionId: string,
    currency = "GBP",
  ): Promise<void> => {
    const checkout = stubRetrieveCheckoutById(
      reference,
      "PAID",
      transactionId,
      currency,
    );
    let returned = false;
    const refund = installRefundObservation(() => returned);
    try {
      expect((await postSumupWebhook()).status).toBe(503);
      expect((await postSumupWebhook()).status).toBe(503);
      expect(refund.send.calls).toHaveLength(1);

      returned = true;
      // Assert body and status together: on a failure the body says which
      // 503 came back (busy page, refund failed, verification refused).
      const settled = await postSumupWebhook();
      expect({
        body: await settled.text(),
        status: settled.status,
      }).toMatchObject({ status: 200 });
      expect(refund.send.calls).toHaveLength(1);
    } finally {
      refund.send.restore();
      refund.read.restore();
      checkout.restore();
    }
  };

  test("does not send a rejected SumUp charge twice while its first refund is not yet visible", async () => {
    const { reference } = await stageSumupCheckout();
    await expectOneRefundAcrossRetries(reference, "txn_rejected_once", "GB");
  });

  test("does not release a reserved failed booking into a second SumUp refund", async () => {
    const { listing, reference } = await stageSumupCheckout();
    await deactivateTestListing(listing.id);
    await expectOneRefundAcrossRetries(reference, "txn_reserved_once");
  });

  test("shares one SumUp refund between a browser return and webhook", async () => {
    const { reference } = await stageSumupCheckout();
    const checkout = stubRetrieveCheckoutById(
      reference,
      "PAID",
      "txn_callback_race",
      "GB",
    );
    const refund = installRefundObservation(() => false);
    try {
      const [browser, webhook] = await Promise.all([
        handleRequest(mockRequest(`/payment/success?session_id=${reference}`)),
        postSumupWebhook(),
      ]);
      expect([browser.status, webhook.status]).toEqual([503, 503]);
      expect(refund.send.calls).toHaveLength(1);
      expect(
        await queryAll<{
          refund_revision: number;
          refund_state_name: string;
        }>("SELECT refund_revision, refund_state_name FROM payment_charges"),
      ).toEqual([{ refund_revision: 3, refund_state_name: "observing" }]);
    } finally {
      refund.send.restore();
      refund.read.restore();
      checkout.restore();
    }
  });

  for (const [name, providerCallLanded] of [
    ["before its provider call", false],
    ["after its provider call", true],
  ] as const) {
    test(`does not repeat a keyless refund after crashing ${name}`, async () => {
      const { reference } = await stageSumupCheckout();
      const checkout = stubRetrieveCheckoutById(
        reference,
        "PAID",
        `txn_crash_${providerCallLanded}`,
        "GB",
      );
      let returned = false;
      let attempts = 0;
      let providerCalls = 0;
      const read = stub(sumupPaymentProvider, "readCharge", () =>
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
        const settled = await postSumupWebhook();
        expect({
          body: await settled.text(),
          status: settled.status,
        }).toMatchObject({ status: 200 });
        expect(attempts).toBe(1);
      } finally {
        refund.restore();
        read.restore();
        checkout.restore();
      }
    });
  }
});
