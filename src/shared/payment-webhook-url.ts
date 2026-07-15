/**
 * One home for the payment webhook URL: the route Stripe/Square/SumUp deliver
 * signed payment callbacks to, and the page a customer's browser lands on
 * after a hosted checkout. Replacing a provider's endpoint (or building the URL
 * a webhook signature is verified against) goes through here so every caller
 * reads the same host.
 *
 * The constructor is pure (taking the domain in), leaving the domain lookup to a
 * thin wrapper so the URL shape can be unit-tested without seeding a domain.
 */

import { getEffectiveDomain } from "#shared/config.ts";

/** The fixed path under the effective domain that receives payment callbacks. */
const PAYMENT_WEBHOOK_PATH = "/payment/webhook";

/** Build the public payment webhook URL for the given domain. */
const paymentWebhookUrl = (domain: string): string =>
  `https://${domain}${PAYMENT_WEBHOOK_PATH}`;

/** Build the payment webhook URL from the current effective domain. */
export const getPaymentWebhookUrl = (): string =>
  paymentWebhookUrl(getEffectiveDomain());
