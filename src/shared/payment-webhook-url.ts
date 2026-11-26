/**
 * One home for the payment webhook URL: the route Stripe/Square/SumUp deliver
 * signed payment callbacks to, and the page a customer's browser lands on
 * after a hosted checkout. Replacing a provider's endpoint (or building the URL
 * a webhook signature is verified against) goes through here so every caller
 * reads the same host.
 *
 * The constructor is pure and lives in `payment-webhook-address.ts`, so a
 * script can build the same address. This module holds the domain lookup.
 */

import { getEffectiveDomain } from "#shared/config.ts";
import { paymentWebhookUrl } from "#shared/payment-webhook-address.ts";

/** Build the payment webhook URL from the current effective domain. */
export const getPaymentWebhookUrl = (): string =>
  paymentWebhookUrl(getEffectiveDomain());
