// effects: pure
/** The stored column values that keep one subscription plan on a booking row.
 * A write that copies a row copies them all, or the plan is lost.
 */

import type {
  RecurringInterval,
  SubscriptionPlan,
  SubscriptionStatus,
} from "./plan.ts";

/** The stored columns a booking row keeps for one plan. */
export type StoredPlanColumns = {
  recurringInterval: RecurringInterval;
  recurringPrice: number;
  recurringTax: number;
  subscriptionId: string;
  subscriptionStatus: SubscriptionStatus;
};

/** The plan columns a subscription row writes, or null for an ordinary row. */
export const subscriptionPlanColumns = (
  plan: SubscriptionPlan | undefined,
): StoredPlanColumns | null =>
  plan === undefined
    ? null
    : {
        recurringInterval: plan.interval,
        recurringPrice: plan.amount,
        recurringTax: plan.tax,
        subscriptionId: plan.id,
        subscriptionStatus: plan.status,
      };
