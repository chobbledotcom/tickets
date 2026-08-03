/** Resolve the provider used for payments that already exist. */

import { compact, map, pipe } from "#fp";
import { settings } from "#shared/db/settings.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const providerHasCredentials: Record<PaymentProviderType, () => boolean> = {
  square: () => settings.square.hasToken,
  stripe: () => settings.stripe.hasKey,
  sumup: () => settings.sumup.hasKey,
};

/** Providers with credentials stored on this site. */
export const configuredPaymentProviderTypes = (): PaymentProviderType[] =>
  pipe(
    map((provider: PaymentProviderType) =>
      providerHasCredentials[provider]() ? provider : null,
    ),
    compact,
  )(PAYMENT_PROVIDER_IDS);

/** Stubbable settings reads used by the existing-payment resolver. */
export const existingPaymentProviderApi = {
  getConfigured: configuredPaymentProviderTypes,
  getCurrent: (): PaymentProviderType | null => settings.paymentProvider,
  getRaw: (): string | null =>
    settings.getCachedRaw(CONFIG_KEYS.PAYMENT_PROVIDER),
  getRemembered: (): PaymentProviderType | null =>
    settings.lastActivePaymentProvider,
  getStored: () => settings.paymentProviderSetting,
};

export type ExistingPaymentProviderState = {
  provider: PaymentProviderType | null;
  recoveryChoices: PaymentProviderType[];
};

/**
 * Resolve the provider for existing payments and any choice needed to recover
 * an ambiguous sales-off site.
 */
export const existingPaymentProviderState = (
  current = existingPaymentProviderApi.getCurrent(),
): ExistingPaymentProviderState => {
  if (current) return { provider: current, recoveryChoices: [] };

  const stored = existingPaymentProviderApi.getStored();
  const raw = existingPaymentProviderApi.getRaw();
  if (stored === null && raw !== null && raw !== "") {
    throw new Error(`Invalid payment_provider setting: ${raw}`);
  }

  const remembered = existingPaymentProviderApi.getRemembered();
  if (remembered) return { provider: remembered, recoveryChoices: [] };

  const configured = existingPaymentProviderApi.getConfigured();
  const onlyProvider = configured.length === 1 ? configured[0] : undefined;
  return onlyProvider
    ? { provider: onlyProvider, recoveryChoices: [] }
    : { provider: null, recoveryChoices: configured };
};

/** Provider type for refunds, callbacks, and existing-payment UI. */
export const existingPaymentProviderType = (): PaymentProviderType | null =>
  existingPaymentProviderState().provider;
