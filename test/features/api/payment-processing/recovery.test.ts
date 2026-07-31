import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import type { PaymentWork } from "#routes/api/webhook-types.ts";
import { applyPaymentSessionClaimKeepingLease } from "#shared/db/payments/claims.ts";
import { paymentProgress } from "#shared/payment-runtime/progress.ts";
import { PAYMENT_ID, READY_RESULT } from "#test/shared/db/payments/fixtures.ts";
import { createPendingPayment } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimPaymentReadyToFinish,
  paymentWorkForCompletion,
} from "#test-utils/payment-completion.ts";

/** A claim that has since been overtaken: the payment moved on, so this
 *  reading of it no longer proves anything about what was written. */
const overtakenWork = async (): Promise<PaymentWork> => {
  const payment = await createPendingPayment();
  const processing = await claimPaymentReadyToFinish(
    PAYMENT_ID,
    READY_RESULT,
    payment,
  );
  const work = paymentWorkForCompletion(processing, READY_RESULT);
  // The payment moves on again, leaving the reading above behind.
  await applyPaymentSessionClaimKeepingLease(
    processing.claim,
    paymentProgress(processing.payment, {
      nextReconcileAt: Date.now() + 120_000,
      result: READY_RESULT,
      resultState: "succeeded",
      state: "processing",
    }),
  );
  return work;
};

describeWithEnv("recovering from an uncertain booking", { db: true }, () => {
  test("raises the original problem when it cannot prove nothing was saved", async () => {
    // Money is only sent back when the record proves the booking never
    // landed. Here the payment has moved on since this reading, so the
    // booking may well exist — sending money back could take away a real
    // ticket, and the honest answer is to let the problem surface.
    const work = await overtakenWork();
    const original = new Error("the booking write blew up");

    await expect(
      recoverOrRefundUnexpectedCreate({
        complete: () => {
          throw new Error("should not finish the booking");
        },
        error: original,
        placeholders: [],
        ticketToken: "token-nobody-holds",
        work,
      }),
    ).rejects.toBe(original);
  });
});
