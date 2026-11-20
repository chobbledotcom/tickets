// effects: pure
/**
 * The Stripe deliveries that report a subscription: each change of its status,
 * and each invoice payment that Stripe takes or refuses.
 *
 * The site asks its webhook endpoint for these events, and records what a
 * delivery reports through one Stripe read. A name that Stripe does not send
 * stops the type check of the endpoint parameters.
 */
export const SUBSCRIPTION_WEBHOOK_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
] as const;

export type SubscriptionWebhookEvent =
  (typeof SUBSCRIPTION_WEBHOOK_EVENTS)[number];
