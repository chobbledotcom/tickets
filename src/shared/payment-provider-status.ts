/**
 * What the stored settings say about one payment provider.
 *
 * The registry in `payment-providers.ts` holds the facts that are true of a
 * provider anywhere. These are the facts that are true of it *on this site*,
 * and each one is an exhaustive `Record<PaymentProviderType, …>`, so a new
 * provider is a compile error here rather than a page that quietly shows a
 * blank or reaches for the wrong hosts.
 */

import { settings } from "#db/settings.ts";
import type { PaymentProviderType } from "#types";

/** Which of a provider's estates the stored credentials point at. A provider
 * with a separate test estate reports `sandbox`. The card providers report
 * the kind of secret key that is stored, and `unknown` when no key is. */
export type PaymentProviderMode = "live" | "sandbox" | "test" | "unknown";

const providerMode: Record<PaymentProviderType, () => PaymentProviderMode> = {
  square: () => (settings.square.sandbox ? "sandbox" : "live"),
  stripe: () => settings.stripe.keyMode ?? "unknown",
  sumup: () => settings.sumup.keyMode ?? "unknown",
};

/** The estate this site's stored credentials for one provider point at. */
export const paymentProviderMode = (
  provider: PaymentProviderType,
): PaymentProviderMode => providerMode[provider]();

const providerHasCredentials: Record<PaymentProviderType, () => boolean> = {
  square: () => settings.square.hasToken,
  stripe: () => settings.stripe.hasKey,
  sumup: () => settings.sumup.hasKey,
};

/** Whether this provider has the stored credentials needed for an API read. */
export const paymentProviderHasCredentials = (
  provider: PaymentProviderType,
): boolean => providerHasCredentials[provider]();
