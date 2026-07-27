import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import {
  describeSumup,
  stubSumupProvider,
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
});
