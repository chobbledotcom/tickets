import { hmacHash } from "#shared/crypto/hashing.ts";
import { settings } from "#shared/db/settings.ts";
import { namedError } from "#shared/named-error.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { PaymentMode } from "#shared/payment-state/observation.ts";
import type { PaymentProviderType } from "#shared/types.ts";

export interface PaymentAccount {
  accountId: string;
  mode: PaymentMode;
  provider: PaymentProviderType;
}

type AccountContext = { mode: PaymentMode | null; parts: string[] };
type StripeAccountCache = { accountId: string; secretKey: string };

let stripeAccountCache: StripeAccountCache | null = null;

export class PaymentAccountConfigurationError extends namedError(
  "PaymentAccountConfigurationError",
) {}

const requireValue = (
  value: string,
  provider: string,
  field: string,
): string => {
  if (value === "") {
    throw new PaymentAccountConfigurationError(
      `${provider} payment ${field} is missing`,
    );
  }
  return value;
};

const accountContexts: Record<
  PaymentProviderType,
  () => AccountContext | Promise<AccountContext>
> = {
  square: () => {
    requireValue(settings.square.accessToken, "Square", "credentials");
    return {
      mode: settings.square.sandbox ? "test" : "live",
      parts: [requireValue(settings.square.locationId, "Square", "account")],
    };
  },
  stripe: async () => {
    const secretKey = requireValue(
      settings.stripe.secretKey,
      "Stripe",
      "credentials",
    );
    const mode = settings.stripe.keyMode;
    if (mode === null) return { mode, parts: [] };
    if (stripeAccountCache?.secretKey === secretKey) {
      return { mode, parts: [stripeAccountCache.accountId] };
    }
    const account = await (
      await import("#shared/stripe.ts")
    ).stripeApi.retrieveAccount();
    if (account === null)
      throw new Error("Stripe payment account is unavailable");
    stripeAccountCache = { accountId: account.id, secretKey };
    return { mode, parts: [account.id] };
  },
  sumup: () => {
    requireValue(settings.sumup.apiKey, "SumUp", "credentials");
    return {
      mode: settings.sumup.keyMode,
      parts: [requireValue(settings.sumup.merchantCode, "SumUp", "account")],
    };
  },
};

const configuredPaymentProviders = (): PaymentProviderType[] => [
  ...(settings.square.accessToken !== "" && settings.square.locationId !== ""
    ? ["square" as const]
    : []),
  ...(settings.stripe.secretKey !== "" && settings.stripe.keyMode !== null
    ? ["stripe" as const]
    : []),
  ...(settings.sumup.apiKey !== "" &&
  settings.sumup.merchantCode !== "" &&
  settings.sumup.keyMode !== null
    ? ["sumup" as const]
    : []),
];

/** Resolve every configured choice to the exact non-secret account shown. */
export const configuredPaymentAccounts = (): Promise<PaymentAccount[]> =>
  Promise.all(configuredPaymentProviders().map(resolvePaymentAccount));

/** Resolve one configured provider's stable, non-secret account identity. */
export const resolvePaymentAccount = async (
  provider: PaymentProviderType,
): Promise<PaymentAccount> => {
  const context = await accountContexts[provider]();
  if (context.mode === null) {
    const label = PAYMENT_PROVIDERS[provider].label;
    throw new PaymentAccountConfigurationError(
      `${label} payment mode is not usable`,
    );
  }
  return {
    accountId: await hmacHash(
      JSON.stringify([provider, context.mode, ...context.parts]),
    ),
    mode: context.mode,
    provider,
  };
};

/** Require the current credentials to address the payment's stored account. */
export const requireStoredPaymentAccount = async (
  expected: PaymentAccount,
): Promise<PaymentAccount> => {
  const current = await resolvePaymentAccount(expected.provider);
  if (
    current.accountId !== expected.accountId ||
    current.mode !== expected.mode
  ) {
    const label = PAYMENT_PROVIDERS[expected.provider].label;
    throw new PaymentAccountConfigurationError(
      `${label} payment account or mode changed`,
    );
  }
  return current;
};
