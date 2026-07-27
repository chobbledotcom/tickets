import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import {
  createStoredSumupPayment,
  describeSumup,
  foundSumupCheckout,
  foundSumupTransaction,
  stubSumupProvider,
  sumupCheckoutResource,
  sumupCheckoutSnapshot,
  sumupTransaction,
} from "#test/shared/sumup/fixtures.ts";

const chargeToRefund = () =>
  paymentCharge({ pendingRefundIdempotencyKey: null, refundState: "none" });

describeSumup("SumUp provider edges", () => {
  test("says SumUp needs no webhook to be set up", async () => {
    expect(
      await sumupPaymentProvider.setupWebhookEndpoint("secret", "https://x"),
    ).toMatchObject({ success: false });
  });

  test("a notice that is not JSON at all is refused", async () => {
    expect(
      await sumupPaymentProvider.verifyWebhookSignature(
        "not json",
        "",
        "",
        new Uint8Array(),
      ),
    ).toMatchObject({ error: "Invalid JSON payload", valid: false });
  });

  test("a refund SumUp will not take is reported as failed", async () => {
    using _sumup = stubSumupProvider({
      refund: () => Promise.resolve({ status: "rejected" as const }),
    });

    expect(
      await sumupPaymentProvider.refundCharge(chargeToRefund(), "key-1"),
    ).toMatchObject({ status: "failed" });
  });

  test("a refund SumUp cannot answer about is left pending", async () => {
    using _sumup = stubSumupProvider({
      transaction: () => Promise.resolve({ status: "unavailable" as const }),
    });

    expect(
      await sumupPaymentProvider.refundCharge(
        paymentCharge({
          pendingRefundIdempotencyKey: null,
          refundState: "pending",
        }),
        "key-2",
      ),
    ).toMatchObject({ status: "pending" });
  });

  test("a refund on a transaction SumUp has lost is reported as failed", async () => {
    using _sumup = stubSumupProvider({
      transaction: () => Promise.resolve({ status: "missing" as const }),
    });

    expect(
      await sumupPaymentProvider.refundCharge(
        paymentCharge({
          pendingRefundIdempotencyKey: null,
          refundState: "pending",
        }),
        "key-3",
      ),
    ).toMatchObject({ status: "failed" });
  });

  test("a refund whose transaction no longer matches is reported as failed", async () => {
    // The amount SumUp reports is not the amount we captured, so this is not
    // the transaction the refund was for.
    using _sumup = stubSumupProvider({
      transaction: () =>
        Promise.resolve({
          status: "found" as const,
          value: sumupTransaction({
            amount: { amount: 25, currency: "GBP" },
          }),
        }),
    });

    expect(
      await sumupPaymentProvider.refundCharge(
        paymentCharge({
          pendingRefundIdempotencyKey: null,
          refundState: "pending",
        }),
        "key-4",
      ),
    ).toMatchObject({ status: "failed" });
  });

  test("reports a checkout SumUp would not create", async () => {
    // Without a merchant code SumUp cannot be asked at all, so there is no
    // checkout to send the buyer to.
    settings.setForTest({ sumup_merchant_code: "" });

    expect(
      await sumupPaymentProvider.createCheckout(await sumupCheckoutSnapshot()),
    ).toBeNull();
  });

  test("refuses a checkout charging a different amount than we asked for", async () => {
    const payment = await createStoredSumupPayment();
    using _sumup = stubSumupProvider({
      checkout: () => foundSumupCheckout({ amountMinor: 2_500 }),
    });

    expect(
      await sumupPaymentProvider.readPayment(payment, sumupCheckoutResource),
    ).toMatchObject({ reason: "malformed_response", status: "invalid" });
  });

  test("reports a refund SumUp says did not work", async () => {
    const payment = await createStoredSumupPayment();
    using _sumup = stubSumupProvider({
      transaction: () =>
        foundSumupTransaction({
          refunds: [
            { amount: { amount: 400, currency: "GBP" }, status: "failed" },
          ],
        }),
    });

    expect(
      await sumupPaymentProvider.readPayment(payment, sumupCheckoutResource),
    ).toMatchObject({
      observation: {
        charges: [
          {
            refunds: [
              {
                amount: { amount: 400, currency: "GBP" },
                reason: "provider_failed",
                status: "failed",
              },
            ],
          },
        ],
      },
    });
  });

  test("cannot read a payment whose transaction SumUp will not answer about", async () => {
    const payment = await createStoredSumupPayment();
    using _sumup = stubSumupProvider({
      transaction: () => Promise.resolve({ status: "unavailable" as const }),
    });

    expect(
      await sumupPaymentProvider.readPayment(payment, sumupCheckoutResource),
    ).toMatchObject({ reason: "provider_unavailable", status: "unavailable" });
  });
});
