/** Stop future charges before a failed checkout finishes. */

import { stripeApi } from "#shared/stripe.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStart,
} from "#shared/subscriptions/plan.ts";

/** A refused cancel can mean that another caller ended it. Keep the original
 * status so the scheduled check still records paid invoices. */
export const endFailedCheckoutSubscription = async (
  start: SubscriptionStart | undefined,
): Promise<void> => {
  if (start === undefined || SUBSCRIPTION_NODE_OF[start.status] === "ended") {
    return;
  }
  const cancelled = await stripeApi.cancelSubscription(start.id);
  const observed =
    cancelled.status === "found"
      ? cancelled
      : await stripeApi.readSubscription(start.id);
  if (
    observed.status !== "found" ||
    SUBSCRIPTION_NODE_OF[observed.resource.status] !== "ended"
  ) {
    throw new Error(
      `Failed checkout subscription ${start.id} did not end: ${JSON.stringify(observed)}`,
    );
  }
};
