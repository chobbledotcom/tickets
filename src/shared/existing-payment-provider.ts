import { settings } from "#db/settings.ts";
import { compact, map, pipe } from "#fp";
import { paymentProviderHasCredentials } from "#shared/payment-provider-status.ts";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import type { PaymentProviderType } from "#types";

const configuredPaymentProviderTypes = (): PaymentProviderType[] =>
  pipe(
    map((provider: PaymentProviderType) =>
      paymentProviderHasCredentials(provider) ? provider : null,
    ),
    compact,
  )(PAYMENT_PROVIDER_IDS);

export type ExistingPaymentProviderState = {
  provider: PaymentProviderType | null;
  recoveryChoices: PaymentProviderType[];
};

/** Resolve the provider for existing payments and any required recovery choice. */
export const existingPaymentProviderState = (
  current = settings.paymentProvider,
): ExistingPaymentProviderState => {
  const stored = settings.paymentProviderSetting;
  const raw = settings.getCachedRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
  if (stored === null && raw !== null && raw !== "") {
    throw new Error(`Invalid payment_provider setting: ${raw}`);
  }

  const configured = configuredPaymentProviderTypes();
  if (current && configured.includes(current)) {
    return { provider: current, recoveryChoices: [] };
  }

  const remembered = settings.lastActivePaymentProvider;
  if (remembered && configured.includes(remembered)) {
    return { provider: remembered, recoveryChoices: [] };
  }

  const onlyProvider = configured.length === 1 ? configured[0] : undefined;
  return onlyProvider
    ? { provider: onlyProvider, recoveryChoices: [] }
    : { provider: null, recoveryChoices: configured };
};
