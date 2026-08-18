/**
 * One pass of the SumUp recovery task: take the checkouts whose check time
 * has come, ask SumUp what became of each, and move its row on.
 *
 * Nothing here decides money. The provider read, the payment engine and the
 * moves table each answer their own question, and this only carries the
 * answer from one to the next.
 */

import { settlePaymentCallback } from "#routes/api/payment-callback.ts";
import {
  applySumupRecoveryEvent,
  type DueSumupCheckout,
  delaySumupRecoveryCheck,
  getDueSumupCheckouts,
} from "#shared/db/sumup-recovery.ts";
import { errorMessage } from "#shared/error-message.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { RecoveryEventId } from "#shared/payment/sumup-recovery-machine-spec.ts";
import { resolveSumupCheckoutById } from "#shared/sumup/checkout-resolution.ts";
import { sumupRecoveryOutcome } from "#shared/sumup/recovery.ts";

/** Ask about one checkout and record what the answer amounted to.
 *
 * Asking is caught per row: one checkout blowing up must not stop the rows
 * behind it. Recording the answer is not caught — a refused write is the
 * database's problem, not this row's, and throws to the task's own retry.
 */
const recoverOne = async (checkout: DueSumupCheckout): Promise<void> => {
  let event: RecoveryEventId;
  try {
    const { reading, resolved } = await resolveSumupCheckoutById(
      checkout.sumupId,
    );
    event = sumupRecoveryOutcome(
      reading,
      await settlePaymentCallback(resolved, "Recovery check"),
    );
  } catch (error) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `SumUp recovery check failed for ${checkout.sumupId}: ${errorMessage(error)}`,
    });
    await delaySumupRecoveryCheck(checkout);
    return;
  }
  const wrote = await applySumupRecoveryEvent(checkout, event);
  // Losing the write means another runner answered this row first, with the
  // same evidence. Its answer stands; ours would only overwrite the check
  // time it just set.
  logDebug(
    "SumUp",
    wrote
      ? `Recovery check answered ${event}`
      : "Recovery check was beaten to a checkout",
  );
};

/**
 * Run one batch. Returns whether a full batch was taken, so the caller can
 * ask to be run again rather than working through a backlog inside one
 * request's subrequest budget.
 */
export const runSumupRecovery = async (): Promise<boolean> => {
  const due = await getDueSumupCheckouts();
  for (const checkout of due) {
    await recoverOne(checkout);
  }
  return due.length === SUMUP_RECOVERY_BATCH;
};
