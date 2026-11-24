/**
 * One pass of the subscription status check. For each live subscription, the
 * pass reads the subscription from Stripe, then records its paid renewals and
 * its status.
 */

import { LedgerConflictError } from "#accounting/conflicts.ts";
import { getCheckedRows, type LiveRow } from "#db/subscriptions.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { requireValue } from "#shared/required-value.ts";
import { SUBSCRIPTION_CHECK_BATCH } from "#shared/subscriptions/limits.ts";
import { recordStripeReport } from "#shared/subscriptions/record.ts";

/** A ledger conflict needs an operator, and every later pass meets it again.
 * The check logs it and moves on, so one row cannot stop the check of every
 * later row. Any other failure stops the run. */
const recordRow = async (row: LiveRow): Promise<void> => {
  try {
    await recordStripeReport(row);
  } catch (error) {
    if (!(error instanceof LedgerConflictError)) throw error;
    logError({
      attendeeId: row.attendeeId,
      code: ErrorCode.LEDGER_POST,
      detail: `Subscription ${row.subscriptionId} was skipped: ${error.message}`,
      error,
      listingId: row.listingId,
    });
  }
};

/** One pass of the check: the next batch of live subscriptions after the
 * checkpoint. A refused read or a ledger conflict leaves that row for the
 * next pass. A full batch asks for another run. A short one starts the next
 * pass from the first row. */
export const runSubscriptionCheck = async ({
  checkpoint,
  requestFollowUp,
  setCheckpoint,
}: MaintenanceTaskContext): Promise<void> => {
  const rows = await getCheckedRows(
    Number(checkpoint ?? 0),
    SUBSCRIPTION_CHECK_BATCH,
  );
  for (const row of rows) {
    await recordRow(row);
  }
  if (rows.length < SUBSCRIPTION_CHECK_BATCH) {
    setCheckpoint(null);
    return;
  }
  setCheckpoint(String(requireValue(rows.at(-1), "Full batch is empty").id));
  requestFollowUp();
};
