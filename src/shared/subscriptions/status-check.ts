/**
 * One pass of the subscription status check. For each live subscription, the
 * pass reads the subscription from Stripe, then records its paid renewals and
 * its status.
 */

import { type CheckedRow, getCheckedRows } from "#db/subscriptions.ts";
import { checkedStatusNode } from "#payment/subscription-machine-spec.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeApi } from "#shared/stripe.ts";
import { SUBSCRIPTION_CHECK_BATCH } from "#shared/subscriptions/limits.ts";
import {
  readForSubscriptionOrNull,
  recordObserved,
} from "#shared/subscriptions/record.ts";

/** Check one subscription. A refused read leaves the row for the next pass. */
const checkOne = async (row: CheckedRow): Promise<void> => {
  const subscription = await readForSubscriptionOrNull(
    row,
    stripeApi.readSubscription,
  );
  if (subscription === null) return;
  const observed = subscription.status;
  checkedStatusNode(row.subscription_status, observed);
  await recordObserved(row, observed);
};

/** One pass of the check: the next batch of live subscriptions after the
 * checkpoint. A full batch asks for another run. A short one starts the next
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
    await checkOne(row);
  }
  if (rows.length < SUBSCRIPTION_CHECK_BATCH) {
    setCheckpoint(null);
    return;
  }
  setCheckpoint(String(requireValue(rows.at(-1), "Full batch is empty").id));
  requestFollowUp();
};
