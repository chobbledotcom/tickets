/**
 * Deep links to view a payment on the configured provider's dashboard.
 *
 * The attendee record only stores the provider's payment reference
 * (e.g. a Stripe payment intent id), not which provider produced it.
 * The active provider — and whether it is in test/sandbox mode — comes
 * from settings, so the link is built against the currently configured
 * provider.
 */

import { settings } from "#shared/db/settings.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Build a provider dashboard URL for a single payment reference. */
const urlBuilders: Record<PaymentProviderType, (id: string) => string> = {
  square: (id) =>
    `https://${
      settings.square.sandbox ? "squareupsandbox.com" : "squareup.com"
    }/dashboard/sales/transactions/${id}`,
  stripe: (id) =>
    `https://dashboard.stripe.com/${
      settings.stripe.keyMode === "test" ? "test/" : ""
    }payments/${id}`,
  sumup: (id) => `https://me.sumup.com/sales/transactions/${id}`,
};

/**
 * Build a link to view a payment on the configured provider's dashboard.
 * Returns null when there is no payment id or no provider is configured.
 */
export const paymentDashboardUrl = (paymentId: string): string | null => {
  if (!paymentId) return null;
  const provider = settings.paymentProvider;
  if (!provider) return null;
  return urlBuilders[provider](encodeURIComponent(paymentId));
};
