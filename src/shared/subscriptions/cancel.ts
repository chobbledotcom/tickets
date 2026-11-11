/** The owner cancels one subscription. The cancel takes effect at once, it
 * refunds nothing, and the booking stays. */

import type { CheckedRow } from "#db/subscriptions.ts";
import { SUBSCRIPTION_NODE_OF } from "#payment/subscription-machine-spec.ts";
import { stripeApi } from "#shared/stripe.ts";
import { recordObserved, unread } from "#shared/subscriptions/record.ts";

/**
 * Cancel the subscription of `row` in Stripe, then record what Stripe reports
 * with its last paid renewals. True when Stripe reports the subscription
 * ended. Stripe refuses to cancel a subscription that already ended, so a
 * refused cancel reads the subscription instead. A second owner, or a cancel
 * in the Stripe dashboard, then gives the same answer.
 */
export const cancelOwnerSubscription = async (
  row: CheckedRow,
): Promise<boolean> => {
  const cancelled = await stripeApi.cancelSubscription(row.subscription_id);
  const answer =
    cancelled.status === "found"
      ? cancelled
      : await stripeApi.readSubscription(row.subscription_id);
  if (answer.status !== "found") {
    unread(row, answer);
    return false;
  }
  const observed = answer.resource.status;
  await recordObserved(row, observed);
  return SUBSCRIPTION_NODE_OF[observed] === "ended";
};
