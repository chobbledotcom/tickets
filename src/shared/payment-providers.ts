/**
 * Payment-provider metadata registry.
 *
 * Provider *behaviour* already lives behind the `PaymentProvider` interface and
 * its per-type loader `Record`. This registry does the same for provider
 * *metadata* — the display label, the radio value, and the webhook signature
 * header — that used to be re-spelled by hand in the settings radio list, the
 * webhook header chain, and each settings route.
 *
 * One exhaustive `Record<PaymentProviderType, …>` means adding a provider is a
 * single compile error here rather than a hunt through scattered literals.
 */

import { t } from "#i18n";
import type { PaymentProviderType } from "#types";

export type PaymentProviderMeta = {
  /** Human-readable display name — radio label and prose. */
  readonly label: string;
  /** Request header carrying the webhook signature, or null for providers whose
   * webhooks are unsigned (authenticity is re-established via the provider API
   * instead — see `PaymentProvider.requiresWebhookSignature`). */
  readonly webhookSignatureHeader: string | null;
  /** Upper-case ISO 4217 codes, or `null` when it takes every currency. */
  readonly currencies: ReadonlySet<string> | null;
  /** The provider's checkout-metadata caps: the longest value it accepts, an
   * optional limit on how many entries a session may carry, and whether the
   * small fields are packed into one entry to fit that limit. An unbounded
   * (Infinity, no maxEntries) provider makes cap enforcement a no-op. */
  readonly metadata: {
    readonly maxValueLength: number;
    readonly maxEntries?: number;
    readonly packs: boolean;
  };
};

/** Provider metadata keyed by identifier. Declaration order drives the settings
 * radio list, so keep it in the order operators should see. */
export const PAYMENT_PROVIDERS = {
  square: {
    currencies: null,
    label: "Square",
    // Square allows only 10 metadata entries of 255 characters each — the
    // tightest caps of any provider, and the reason small fields are packed
    // into one `b` entry (see packMetadata in payment-helpers.ts).
    metadata: { maxEntries: 10, maxValueLength: 255, packs: true },
    webhookSignatureHeader: "x-square-hmacsha256-signature",
  },
  stripe: {
    currencies: null,
    label: "Stripe",
    metadata: { maxEntries: 50, maxValueLength: 500, packs: false },
    webhookSignatureHeader: "stripe-signature",
  },
  sumup: {
    // Mirrors the SumUp SDK's Currency union.
    currencies: new Set([
      "BGN",
      "BRL",
      "CHF",
      "CLP",
      "COP",
      "CZK",
      "DKK",
      "EUR",
      "GBP",
      "HRK",
      "HUF",
      "NOK",
      "PLN",
      "RON",
      "SEK",
      "USD",
    ]),
    label: "SumUp",
    // SumUp carries no provider metadata: the booking fields are stored
    // locally (db/sumup-checkouts.ts), so nothing is capped or packed.
    metadata: { maxValueLength: Number.POSITIVE_INFINITY, packs: false },
    webhookSignatureHeader: null,
  },
} as const satisfies Record<PaymentProviderType, PaymentProviderMeta>;

/** Provider ids in declared order. */
export const PAYMENT_PROVIDER_IDS = Object.keys(
  PAYMENT_PROVIDERS,
) as PaymentProviderType[];

/** Why a provider cannot take the site currency, or `null` when it can. */
export const providerCurrencyBlock = (
  id: PaymentProviderType,
  currency: string,
): string | null => {
  const { currencies, label } = PAYMENT_PROVIDERS[id];
  if (currencies === null || currencies.has(currency.toUpperCase())) {
    return null;
  }
  return t("error.provider_currency_unsupported", {
    currency,
    provider: label,
  });
};

/** Webhook signature headers of every provider that signs its webhooks. */
export const WEBHOOK_SIGNATURE_HEADERS: string[] = PAYMENT_PROVIDER_IDS.map(
  (id) => PAYMENT_PROVIDERS[id].webhookSignatureHeader,
).filter((header) => header !== null);
