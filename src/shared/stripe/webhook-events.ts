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

/**
 * The Stripe deliveries that report a checkout as completed. A delayed method,
 * such as a bank debit, completes the checkout unpaid. Stripe then sends the
 * async event when the money arrives. The site holds the first delivery as
 * pending and books the order on the second.
 */
export const STRIPE_CHECKOUT_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const;

export type SubscriptionWebhookEvent =
  (typeof SUBSCRIPTION_WEBHOOK_EVENTS)[number];
