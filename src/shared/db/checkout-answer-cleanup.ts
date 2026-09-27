import { checkoutAnswerIndex } from "#db/checkout-pending-answers.ts";
import { executeBatch, queryAll } from "#db/client.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";

export const TERMINAL_CHECKOUT_CLEANUP_BATCH = 32;

type TerminalSession = {
  row_id: number;
  payment_session_id: string;
};

/** Failed/refunded payments remain durable cleanup work if inline deletion fails. */
export const runTerminalCheckoutCleanup = async (
  checkpoint: string | null,
): Promise<{ checkpoint: string | null; fullBatch: boolean }> => {
  const after = checkpoint === null ? 0 : Number(checkpoint);
  if (checkpoint !== null && !isPositiveSafeInteger(after)) {
    throw new Error("Invalid terminal checkout cleanup checkpoint");
  }
  const sessions = await queryAll<TerminalSession>(
    `SELECT rowid AS row_id, payment_session_id
       FROM processed_payments
      WHERE rowid > ? AND failure_data != ''
      ORDER BY rowid LIMIT ?`,
    [after, TERMINAL_CHECKOUT_CLEANUP_BATCH],
  );
  if (sessions.length !== 0) {
    await executeBatch(await Promise.all(sessions.map(async ({ payment_session_id }) => ({
      sql: "DELETE FROM checkout_pending_answers WHERE session_index = ?",
      args: [await checkoutAnswerIndex(payment_session_id)],
    }))));
  }
  const fullBatch = sessions.length === TERMINAL_CHECKOUT_CLEANUP_BATCH;
  return {
    checkpoint: fullBatch ? String(sessions.at(-1)!.row_id) : null,
    fullBatch,
  };
};
