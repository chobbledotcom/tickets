import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import type { SumupCheckout, SumupTransaction } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { paymentCharge } from "#test/shared/payment-runtime/fixtures.ts";
import {
  createStoredSumupPayment,
  describeSumup,
  foundSumupCheckout,
  foundSumupTransaction,
  refundCompletesOnSecondRead,
  SUMUP_LOCAL_PAYMENT_ID,
  stubSumupProvider,
  sumupCheckoutResource,
  sumupTransactionResource,
} from "#test/shared/sumup/fixtures.ts";

const readWith = async (
  payment: Awaited<ReturnType<typeof createStoredSumupPayment>> | null,
  requested: ProviderResource = sumupCheckoutResource,
  checkout: Partial<SumupCheckout> = {},
  transaction: Partial<SumupTransaction> = {},
) => {
  using _provider = stubSumupProvider({
    checkout: () => foundSumupCheckout(checkout),
    transaction: () => foundSumupTransaction(transaction),
  });
  return await sumupPaymentProvider.readPayment(payment, requested);
};

describeSumup("SumUp typed provider", () => {
  test("returns exact charge facts for a captured transaction", async () => {
    const payment = await createStoredSumupPayment();
    expect(await readWith(payment)).toMatchObject({
      observation: {
        charges: [
          {
            captured: { amount: 1_000, currency: "GBP" },
            resource: {
              id: sumupTransactionResource.id,
              parentId: sumupCheckoutResource.id,
              provider: "sumup",
            },
          },
        ],
        status: "paid",
      },
      status: "found",
    });
  });

  test("preserves cumulative and pending refund facts on a captured charge", async () => {
    const result = await readWith(
      await createStoredSumupPayment(),
      sumupCheckoutResource,
      {},
      {
        refunded: { amount: 400, currency: "GBP" },
        refunds: [
          {
            amount: { amount: 400, currency: "GBP" },
            id: 41,
            status: "completed",
          },
          {
            amount: { amount: 600, currency: "GBP" },
            id: 42,
            status: "pending",
          },
        ],
        status: "REFUNDED",
      },
    );

    expect(result).toMatchObject({
      observation: {
        charges: [
          {
            confirmedRefunded: { amount: 400, currency: "GBP" },
            refunds: [
              {
                amount: { amount: 600, currency: "GBP" },
                status: "pending",
              },
            ],
          },
        ],
        status: "paid",
      },
      status: "found",
    });
  });

  for (const [transactionStatus, paymentStatus] of [
    ["CANCELLED", "failed"],
    ["FAILED", "failed"],
    ["PENDING", "pending"],
  ] as const) {
    test(`does not capture a ${transactionStatus} transaction`, async () => {
      const result = await readWith(
        await createStoredSumupPayment(),
        sumupCheckoutResource,
        {},
        {
          status: transactionStatus,
        },
      );
      expect(result).toMatchObject({
        observation: { status: paymentStatus },
        status: "found",
      });
      if (result.status !== "found") throw new Error("Expected SumUp facts");
      expect(result.observation.charges).toBeUndefined();
    });
  }

  for (const [name, checkout, transaction, reason] of [
    ["checkout reference", { reference: "other" }, {}, "mismatched_id"],
    ["checkout account", { merchantCode: "MC999" }, {}, "mismatched_account"],
    [
      "transaction amount",
      {},
      { amount: { amount: 999, currency: "GBP" } },
      "malformed_response",
    ],
    [
      "transaction currency",
      {},
      { amount: { amount: 1_000, currency: "EUR" } },
      "malformed_response",
    ],
    [
      "transaction account",
      {},
      { merchantCode: "MC999" },
      "malformed_response",
    ],
    [
      "transaction time",
      {},
      { timestamp: "2026-07-26T11:59:59.000Z" },
      "malformed_response",
    ],
  ] as const) {
    test(`rejects mismatched ${name}`, async () => {
      expect(
        await readWith(
          await createStoredSumupPayment(),
          sumupCheckoutResource,
          checkout,
          transaction,
        ),
      ).toMatchObject({ reason, status: "invalid" });
    });
  }

  test("rejects a checkout read through a different SumUp mode", async () => {
    const payment = await createStoredSumupPayment();
    settings.setForTest({ sumup_api_key: "sk_live_sumup" });
    expect(await readWith(payment)).toMatchObject({
      reason: "mismatched_account",
      status: "invalid",
    });
  });

  test("rejects a transaction attached to a different checkout parent", async () => {
    const requested = {
      id: sumupTransactionResource.id,
      kind: "sumup_transaction" as const,
      parentId: "other-checkout",
      provider: "sumup" as const,
    };
    expect(
      await readWith(await createStoredSumupPayment(), requested),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
  });

  test("finds an unattached aggregate by checkout_reference", async () => {
    await createStoredSumupPayment(null);
    expect(await readWith(null)).toMatchObject({
      observation: {
        ownership: {
          localPaymentId: SUMUP_LOCAL_PAYMENT_ID,
          method: "staged",
          stageId: sumupCheckoutResource.id,
        },
      },
      status: "found",
    });
  });

  test("distinguishes a missing checkout from an unavailable checkout", async () => {
    const payment = await createStoredSumupPayment();
    for (const status of ["missing", "unavailable"] as const) {
      {
        using _provider = stubSumupProvider({
          checkout: () => Promise.resolve({ status }),
        });
        expect(
          await sumupPaymentProvider.readPayment(
            payment,
            sumupCheckoutResource,
          ),
        ).toEqual({
          ownership: {
            localPaymentId: payment.id,
            method: "staged",
            stageId: sumupCheckoutResource.id,
          },
          reason: status === "missing" ? "not_found" : "provider_unavailable",
          requested: sumupCheckoutResource,
          status,
        });
      }
    }
  });

  for (const [status, expected] of [
    ["PAID", "paid"],
    ["PENDING", "pending"],
    ["FAILED", "failed"],
  ] as const) {
    test(`a ${status} checkout nobody has paid on yet reads as ${expected}`, async () => {
      // No transaction id, so there is no charge to read — only the checkout's
      // own state says where the money got to.
      const result = await readWith(
        await createStoredSumupPayment(),
        sumupCheckoutResource,
        { status, transactionId: undefined },
      );
      expect(result).toMatchObject({
        observation: { status: expected },
        status: "found",
      });
      if (result.status !== "found") throw new Error("Expected SumUp facts");
      expect(result.observation.charges).toBeUndefined();
    });
  }

  test("a checkout belonging to a different SumUp payment is refused", async () => {
    // The aggregate was staged against one SumUp checkout; the response names
    // another, so it is not ours to read.
    const payment = await createStoredSumupPayment({
      id: "sumup-other-checkout",
      kind: "sumup_checkout",
      provider: "sumup",
    });
    expect(await readWith(payment)).toMatchObject({
      reason: "mismatched_parent",
      status: "invalid",
    });
  });

  test("a resource that is not SumUp's is refused before anything is asked", async () => {
    const payment = await createStoredSumupPayment();
    expect(
      await readWith(payment, {
        id: "cs_stripe",
        kind: "stripe_checkout_session",
        provider: "stripe",
      }),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
  });

  test("a charge asked for by a different transaction id is refused", async () => {
    expect(
      await readWith(
        await createStoredSumupPayment(),
        {
          id: "sumup-other-transaction",
          kind: "sumup_transaction",
          parentId: sumupCheckoutResource.id,
          provider: "sumup",
        },
        {},
        {},
      ),
    ).toMatchObject({ reason: "mismatched_id", status: "invalid" });
  });

  test("a charge asked for on a checkout with no payment on it is refused", async () => {
    // Asking about a charge when the checkout never captured one has no
    // answer, so it is refused rather than reported as an empty success.
    expect(
      await readWith(
        await createStoredSumupPayment(),
        sumupTransactionResource,
        { status: "PENDING" },
        { status: "PENDING" },
      ),
    ).toMatchObject({ reason: "unsupported_status", status: "invalid" });
  });

  test("a checkout the site has never recorded is reported missing", async () => {
    // Nothing staged this checkout, so there is no payment to attach it to.
    expect(
      await readWith(null, sumupCheckoutResource, {
        reference: "never-seen",
      }),
    ).toMatchObject({ status: "missing" });
  });

  test("polls a pending SumUp refund without posting again", async () => {
    using provider = stubSumupProvider({
      refund: () => Promise.reject(new Error("must not post")),
      transaction: () =>
        foundSumupTransaction({
          refunded: { amount: 400, currency: "GBP" },
        }),
    });
    expect(
      await sumupPaymentProvider.refundCharge(
        paymentCharge({
          providerReference: sumupTransactionResource,
          refundState: "pending",
        }),
        "existing-key",
      ),
    ).toEqual({
      amount: { amount: 400, currency: "GBP" },
      status: "partial",
    });
    expect(provider.refund.calls).toHaveLength(0);
  });

  test("polls a stored unresolved request without posting again", async () => {
    using provider = stubSumupProvider({
      refund: () => Promise.reject(new Error("must not post")),
    });

    expect(
      await sumupPaymentProvider.refundCharge(
        paymentCharge({ providerReference: sumupTransactionResource }),
        "existing-key",
      ),
    ).toEqual({
      amount: { amount: 1_000, currency: "GBP" },
      status: "pending",
    });
    expect(provider.refund.calls).toHaveLength(0);
  });

  test("posts an ambiguous refund once, then polls without inventing a resource", async () => {
    using provider = stubSumupProvider({
      transaction: refundCompletesOnSecondRead(),
    });
    const charge = paymentCharge({
      pendingRefundIdempotencyKey: null,
      providerReference: sumupTransactionResource,
      refundState: "none",
    });

    expect(
      await sumupPaymentProvider.refundCharge(charge, "new-sumup-key"),
    ).toEqual({
      amount: { amount: 1_000, currency: "GBP" },
      status: "pending",
    });
    expect(
      await sumupPaymentProvider.refundCharge(
        { ...charge, refundState: "pending" },
        "new-sumup-key",
      ),
    ).toEqual({
      amount: { amount: 1_000, currency: "GBP" },
      status: "completed",
    });
    expect(provider.refund.calls).toHaveLength(1);
  });
});
