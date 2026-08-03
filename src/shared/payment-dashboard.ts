/**
 * Deep links to view an existing payment on its resolved provider dashboard.
 *
 * The attendee record only stores the provider's payment reference
 * (e.g. a Stripe payment intent id), not which provider produced it.
 * The shared existing-payment resolver keeps links available when new sales
 * are off. Test and sandbox modes come from settings.
 */

import { settings } from "#shared/db/settings.ts";
import { existingPaymentProviderType } from "#shared/existing-payment-provider.ts";
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
 * Build a link to view a payment on the resolved provider's dashboard.
 * Returns null when there is no payment id or no provider was ever configured.
 * Uses the shared existing-payment provider resolver so the link stays
 * available when new sales are off.
 */
export const paymentDashboardUrl = (paymentId: string): string | null => {
  if (!paymentId) return null;
  const provider = existingPaymentProviderType();
  return provider ? urlBuilders[provider](encodeURIComponent(paymentId)) : null;
};
