/** Stop subscription charges for an owner or a failed checkout. */

import type { LiveRow } from "#db/subscriptions.ts";
import { isCancellable } from "#payment/subscription-machine-spec.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStart,
} from "#shared/subscriptions/plan.ts";
import {
  readForSubscriptionOrNull,
  recordObserved,
} from "#shared/subscriptions/record.ts";

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

/** What an owner cancel did. `behind` means that Stripe ended the subscription
 * and the row does not hold the end yet. `ended` means that the row already
 * holds an end, so no request went to Stripe. */
export type OwnerCancel = "cancelled" | "behind" | "not_cancelled" | "ended";

/** Cancel at once and record the last paid renewals. A refused cancel reads
 * the current status so concurrent callers get the same result. */
export const cancelOwnerSubscription = async (
  row: LiveRow,
): Promise<OwnerCancel> => {
  if (!isCancellable(row.subscription_status)) return "ended";
  const subscription = await readForSubscriptionOrNull(row, cancelOrRead);
  if (subscription === null) return "not_cancelled";
  const observed = subscription.status;
  const recorded = await recordObserved(row, observed);
  if (SUBSCRIPTION_NODE_OF[observed] !== "ended") return "not_cancelled";
  return recorded ? "cancelled" : "behind";
};
