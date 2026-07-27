import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb } from "#shared/db/client.ts";
import {
  getPaymentCharges,
  savePaymentCharges,
} from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { refundCharges } from "#shared/payment-runtime/refund.ts";
import {
  PAYMENT_TIME,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import { retryRefundUntilStopped } from "#test/shared/payment-runtime/refund-retries.ts";
import {
  createStoredSumupPayment,
  describeSumup,
  foundSumupTransaction,
  refundCompletesOnSecondRead,
  stubSumupProvider,
  sumupCheckoutResource,
  sumupTransactionResource,
} from "#test/shared/sumup/fixtures.ts";

const createRefundablePayment = async () => {
  await createStoredSumupPayment();
  const processing = await requirePaymentSessionClaim("sumup-local", 60_000);
  await applyPaymentSessionClaim(
    processing,
    sessionProgress({ session: sumupCheckoutResource, state: "processing" }),
  );
  const completing = await requirePaymentSessionClaim("sumup-local", 60_000);
  const payment = await applyPaymentSessionClaim(
    completing,
    sessionProgress({ session: sumupCheckoutResource, state: "completed" }),
  );
  await savePaymentCharges(
    payment.id,
    sumupCheckoutResource,
    [
      {
        captured: { amount: 1_000, currency: "GBP" },
        confirmedRefunded: { amount: 0, currency: "GBP" },
        refunds: [],
        resource: sumupTransactionResource,
      },
    ],
    PAYMENT_TIME,
  );
  return payment;
};

describeSumup("SumUp refund aggregate", () => {
  test("never posts twice while an accepted refund has no provider resource", async () => {
    const payment = await createRefundablePayment();
    using provider = stubSumupProvider({
      transaction: refundCompletesOnSecondRead(),
    });

    const pending = await refundCharges(payment);
    const [storedPending] = await getPaymentCharges(payment.id);
    if (storedPending === undefined || !("captured" in storedPending)) {
      throw new Error("Expected pending SumUp charge");
    }
    expect(storedPending.pendingRefund).toBeNull();
    expect(storedPending.pendingRefundIdempotencyKey).not.toBeNull();
    expect(storedPending.refundState).toBe("pending");

    const completed = await refundCharges(pending.payment, [storedPending]);
    expect(completed.status).toBe("completed");
    expect(provider.refund.calls).toHaveLength(1);
  });

  test("stores an authoritative failed refund event as a failed case", async () => {
    const payment = await createRefundablePayment();
    using _provider = stubSumupProvider({
      transaction: () =>
        foundSumupTransaction({
          refunded: { amount: 0, currency: "GBP" },
          refunds: [
            {
              amount: { amount: 1_000, currency: "GBP" },
              id: 91,
              status: "failed" as const,
            },
          ],
        }),
    });

    expect((await refundCharges(payment)).status).toBe("failed");
    expect(
      (
        await getDb().execute(
          "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
          [payment.id],
        )
      ).rows,
    ).toEqual([{ reason: "failed_refund", state: "retrying" }]);
  });

  test("escalates an unobservable accepted refund without posting twice", async () => {
    using time = new FakeTime(PAYMENT_TIME);
    const payment = await createRefundablePayment();
    using provider = stubSumupProvider({
      transaction: () => Promise.resolve({ status: "unavailable" }),
    });

    const current = await retryRefundUntilStopped(time, payment);

    expect(current.state).toBe("needs_action");
    expect(current.nextReconcileAt).toBeNull();
    expect(provider.refund.calls).toHaveLength(1);
    expect(
      (
        await getDb().execute(
          "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
          [payment.id],
        )
      ).rows,
    ).toEqual([{ reason: "refund_pending", state: "needs_action" }]);
  });
});
