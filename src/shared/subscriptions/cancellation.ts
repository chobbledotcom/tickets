/** Stop subscription charges for an owner or a failed checkout. */

import type { CheckedRow } from "#db/subscriptions.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStart,
} from "#shared/subscriptions/plan.ts";
import { recordObserved, unread } from "#shared/subscriptions/record.ts";

const cancelOrRead = async (id: string) => {
  const cancelled = await stripeApi.cancelSubscription(id);
  return cancelled.status === "found"
    ? cancelled
    : stripeApi.readSubscription(id);
};

/** A refused cancel can mean that another caller ended it. Keep the original
 * status so the scheduled check still records paid invoices. */
export const endFailedCheckoutSubscription = async (
  start: SubscriptionStart | undefined,
): Promise<void> => {
  if (start === undefined || SUBSCRIPTION_NODE_OF[start.status] === "ended") {
    return;
  }
  const observed = await cancelOrRead(start.id);
  if (
    observed.status !== "found" ||
    SUBSCRIPTION_NODE_OF[observed.resource.status] !== "ended"
  ) {
    throw new Error(
      `Failed checkout subscription ${start.id} did not end: ${JSON.stringify(observed)}`,
    );
  }
};

/** Cancel at once and record the last paid renewals. A refused cancel reads
 * the current status so concurrent callers get the same result. */
export const cancelOwnerSubscription = async (
  row: CheckedRow,
): Promise<boolean> => {
  const answer = await cancelOrRead(row.subscription_id);
  if (answer.status !== "found") {
    unread(row, answer);
    return false;
  }
  const observed = answer.resource.status;
  await recordObserved(row, observed);
  return SUBSCRIPTION_NODE_OF[observed] === "ended";
};
