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
  square: () => (paymentProviderUsesSandbox("square") ? "sandbox" : "live"),
  stripe: () => settings.stripe.keyMode ?? "unknown",
  sumup: () => settings.sumup.keyMode ?? "unknown",
};

/** The estate this site's stored credentials for one provider point at. This
 * reads that provider's stored key, so a route that calls it must declare the
 * key in its settings bundle. */
export const paymentProviderMode = (
  provider: PaymentProviderType,
): PaymentProviderMode => providerMode[provider]();

/** How to tell whether the site points at a provider's separate test estate,
 * or null for a provider that has only one. A test key for Stripe or SumUp
 * talks to the same hosts as a live one, which is why neither declares its own
 * `checkoutFormOrigins.sandbox`. */
const providerSandboxSwitch: Record<
  PaymentProviderType,
  (() => boolean) | null
> = {
  square: () => settings.square.sandbox,
  stripe: null,
  sumup: null,
};

/** Whether the site points at this provider's separate test estate.
 *
 * The security policy asks this on every response, so it must never reach for
 * a provider's stored credentials — only the routes that declare those keys
 * may read them. A provider with one estate answers without reading anything.
 */
export const paymentProviderUsesSandbox = (
  provider: PaymentProviderType,
): boolean =>
  // No switch is the answer for a provider with one estate: it is never in a
  // sandbox, and nothing about it is read to say so.
  providerSandboxSwitch[provider]?.() ?? false;

const providerHasCredentials: Record<PaymentProviderType, () => boolean> = {
  square: () => settings.square.hasToken,
  stripe: () => settings.stripe.hasKey,
  sumup: () => settings.sumup.hasKey,
};

/** Whether this provider has the stored credentials needed for an API read. */
export const paymentProviderHasCredentials = (
  provider: PaymentProviderType,
): boolean => providerHasCredentials[provider]();
