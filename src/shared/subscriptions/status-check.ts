/**
 * One pass of the subscription status check. For each live subscription, the
 * pass reads the subscription from Stripe, then records its paid renewals and
 * its status.
 */

import { getCheckedRows } from "#db/subscriptions.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { requireValue } from "#shared/required-value.ts";
import { SUBSCRIPTION_CHECK_BATCH } from "#shared/subscriptions/limits.ts";
import { recordStripeReport } from "#shared/subscriptions/record.ts";

/** One pass of the check: the next batch of live subscriptions after the
 * checkpoint. A refused read leaves that row for the next pass. A full batch
 * asks for another run. A short one starts the next pass from the first row. */
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
    await recordStripeReport(row);
  }
  if (rows.length < SUBSCRIPTION_CHECK_BATCH) {
    setCheckpoint(null);
    return;
  }
  setCheckpoint(String(requireValue(rows.at(-1), "Full batch is empty").id));
  requestFollowUp();
};
