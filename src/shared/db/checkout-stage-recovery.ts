import { checkoutStageRetryDelay } from "#shared/checkout-stage-retry.ts";
import {
  type CheckoutStageCleanup,
  checkoutStageCleanupFromRow,
} from "#shared/db/checkout-stages.ts";
import { execute, queryBatchPrimary, resultRows } from "#shared/db/client.ts";

const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const CHECKOUT_STAGE_SCAN_LIMIT = 16;

/** Read a bounded due page from the same primary that owns the task claim. */
export const selectDueCheckoutStages = async (): Promise<
  CheckoutStageCleanup[]
> => {
  const [result] = await queryBatchPrimary([
    {
      args: [CHECKOUT_STAGE_SCAN_LIMIT],
      sql: `SELECT checkout_stage.payment_session_id,
                   checkout_stage.attendee_id,
                   checkout_stage.provider,
                   checkout_stage.provider_checkout_id,
                   checkout_stage.state,
                   checkout_stage.created_at,
                   checkout_stage.next_attempt_at,
                   checkout_stage.attempt_count,
                   checkout_stage.last_attempt_at
              FROM checkout_stages AS checkout_stage
             WHERE checkout_stage.next_attempt_at <= ${DATABASE_NOW_MS}
             ORDER BY checkout_stage.next_attempt_at,
                      checkout_stage.payment_session_id
             LIMIT ?`,
    },
  ]);
  return resultRows<unknown>(result!).map(checkoutStageCleanupFromRow);
};

/** Remember provider payment before expensive local processing starts. */
export const markCheckoutStagePaid = async (
  stage: CheckoutStageCleanup,
): Promise<boolean> => {
  const result = await execute(
    `UPDATE checkout_stages
        SET state = 'paid', next_attempt_at = 0, attempt_count = 0,
            last_attempt_at = NULL
      WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'`,
    [stage.paymentSessionId, stage.attendeeId],
  );
  return result.rowsAffected === 1;
};

/** Move one nonterminal attempt out of the due queue with bounded backoff. */
export const deferCheckoutStage = async (
  stage: CheckoutStageCleanup,
): Promise<void> => {
  const delay = checkoutStageRetryDelay(stage.attemptCount);
  await execute(
    `UPDATE checkout_stages
        SET attempt_count = attempt_count + 1,
            last_attempt_at = ${DATABASE_NOW_MS},
            next_attempt_at = ${DATABASE_NOW_MS} + ?
      WHERE payment_session_id = ? AND attendee_id = ?`,
    [delay, stage.paymentSessionId, stage.attendeeId],
  );
};

/** Milliseconds until the next queued stage, or null when the queue is empty. */
export const nextCheckoutStageAttemptIn = async (): Promise<number | null> => {
  const [result] = await queryBatchPrimary([
    {
      args: [],
      sql: `SELECT MIN(next_attempt_at) - ${DATABASE_NOW_MS} AS delay
              FROM checkout_stages`,
    },
  ]);
  const delay = resultRows<{ delay: number | null }>(result!)[0]!.delay;
  return delay === null ? null : Math.max(0, delay);
};
