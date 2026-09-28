import { sessionWorkIndex } from "#db/checkout-pending-answers.ts";
import { executeBatch, queryAll } from "#db/client.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { MaintenanceSweepOutcome } from "#shared/maintenance/definition.ts";
import { DAY_MS } from "#shared/now.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";

export const TERMINAL_CHECKOUT_CLEANUP_BATCH = 32;

/** A finalized booking whose staged row outlived every replay loses its
 * staged answers after this long, loudly: the operator's recovery for the
 * buyer's email is the admin resend. */
const FINALIZED_STAGING_CUTOFF_MS = 30 * DAY_MS;

type TerminalSession = {
  row_id: number;
  payment_session_id: string;
  finalized: number;
};

/** Failed/refunded payments remain durable cleanup work if inline deletion
 * fails, and a finalized booking's staging that outlived every replay closes
 * loudly rather than leaking sealed answers forever. */
export const runTerminalCheckoutCleanup = async (
  checkpoint: string | null,
): Promise<MaintenanceSweepOutcome> => {
  const after = checkpoint === null ? 0 : Number(checkpoint);
  if (checkpoint !== null && !isPositiveSafeInteger(after)) {
    throw new Error("Invalid terminal checkout cleanup checkpoint");
  }
  const cutoff = new Date(
    Date.now() - FINALIZED_STAGING_CUTOFF_MS,
  ).toISOString();
  const sessions = await queryAll<TerminalSession>(
    `SELECT rowid AS row_id, payment_session_id,
            (attendee_id IS NOT NULL AND failure_data = ''
             AND processed_at < ?) AS finalized
       FROM processed_payments
      WHERE rowid > ?
        AND (failure_data != ''
          OR (attendee_id IS NOT NULL AND failure_data = '' AND processed_at < ?))
      ORDER BY rowid LIMIT ?`,
    [cutoff, after, cutoff, TERMINAL_CHECKOUT_CLEANUP_BATCH],
  );
  if (sessions.length !== 0) {
    const indexes = await Promise.all(
      sessions.map(({ payment_session_id }) =>
        sessionWorkIndex(payment_session_id),
      ),
    );
    await executeBatch(
      indexes.map((index: string) => ({
        args: [index],
        sql: "DELETE FROM checkout_pending_answers WHERE session_index = ?",
      })),
    );
    for (const { finalized, payment_session_id } of sessions) {
      if (finalized !== 1) continue;
      logError({
        code: ErrorCode.PAYMENT_SESSION,
        detail:
          `A finalized booking's staged answers closed after outliving every replay ` +
          `(payment session ${payment_session_id}); its buyer's email recovery is the admin resend`,
      });
    }
  }
  const fullBatch = sessions.length === TERMINAL_CHECKOUT_CLEANUP_BATCH;
  return {
    checkpoint: fullBatch ? String(sessions.at(-1)!.row_id) : null,
    fullBatch,
  };
};
