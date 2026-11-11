// effects: pure
/** The words the Subscriptions page uses for each status and each period. */

import type {
  RecurringInterval,
  SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";

/* jscpd:ignore-start -- a list of strings, not code */
/** The copy key that names each Stripe status to a person. */
export const SUBSCRIPTION_STATUS_LABEL_KEYS: Record<
  SubscriptionStatus,
  string
> = {
  active: "subscriptions.status.active",
  canceled: "subscriptions.status.canceled",
  incomplete: "subscriptions.status.incomplete",
  incomplete_expired: "subscriptions.status.incomplete_expired",
  past_due: "subscriptions.status.past_due",
  paused: "subscriptions.status.paused",
  trialing: "subscriptions.status.trialing",
  unpaid: "subscriptions.status.unpaid",
};

/** The copy key that states a charge and how often Stripe takes it. */
export const RECURRING_CHARGE_KEYS: Record<RecurringInterval, string> = {
  month: "subscriptions.every.month",
  week: "subscriptions.every.week",
  year: "subscriptions.every.year",
};
/* jscpd:ignore-end */
