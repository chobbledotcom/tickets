/** Required Stripe webhook events and the stored version proving they were
 * reconciled. Kept dependency-free so every request can compare the marker
 * without loading Stripe integration code. */
export const REQUIRED_STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
] as const;

export const STRIPE_WEBHOOK_EVENTS_VERSION = "checkout-session-expired-v1";
