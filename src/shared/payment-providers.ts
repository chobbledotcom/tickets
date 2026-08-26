/**
 * Provider *behaviour* is loaded on demand, because it carries the SDK. Every
 * provider fact NOT needing that SDK lives here, so a caller can ask what a
 * provider is like without paying to load it.
 *
 * Nothing outside this file may branch on a provider name. A fact that differs
 * between providers is a column here, and the caller reads the column.
 */

import { mapNotNullish } from "#fp";
import { t } from "#i18n";
import type { PaymentProviderType } from "#types";

/** Whether one exact refund request may safely be repeated. A keyed provider
 * takes an idempotency key and lands a repeat on the original refund; a
 * keyless one has no such key, so asking twice pays twice. */
export type RefundProviderCapability = "keyed" | "keyless";

export type PaymentProviderMeta = {
  /** Origins the provider's hosted checkout posts to, so the page's
   * `form-action` policy lets the buyer leave for it. `sandbox` is named only
   * where the provider hosts its test checkout somewhere else; without it the
   * live origins serve both. */
  readonly checkoutFormOrigins: {
    readonly live: readonly string[];
    readonly sandbox?: readonly string[];
  };
  /** Human-readable display name — radio label and prose. */
  readonly label: string;
  /** Whether one exact refund request may safely be repeated. A keyed
   * provider lands a repeat on the original refund; a keyless one pays
   * twice. */
  readonly refundCapability: RefundProviderCapability;
  /** The settings-form field carrying this provider's secret credential. The
   * field is rendered under this name, the form masks a stored value by it,
   * and the save route reads the mask back out of it, so a change here moves
   * all three together. */
  readonly secretField: string;
  /** How this provider's webhook is wired, or null when it sends none.
   *
   * One nullable column, because the three facts that hang off it must never
   * disagree: the header a signature arrives in, whether the endpoint refuses
   * an unsigned request, and whether an operator has a webhook to repoint
   * after the site's domain changes. A provider whose webhooks are unsigned
   * re-establishes authenticity by reading its own API back instead. */
  readonly webhook: {
    /** Request header carrying the signature. */
    readonly signatureHeader: string;
    /** Catalog key naming what the operator must redo after a domain change. */
    readonly domainChangeFixKey: string;
  } | null;
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

/** Square's buyer-facing checkout hosts are the same in both environments.
 * Only the three API hosts move, so the environment is one word. */
const squareCheckoutOrigins = (apiDomain: string): readonly string[] => [
  "https://square.link",
  "https://checkout.square.site",
  "https://*.squarecdn.com",
  "https://geoissuer.cardinalcommerce.com",
  `https://connect.${apiDomain}`,
  `https://pci-connect.${apiDomain}`,
  `https://api.${apiDomain}`,
];

/** Provider metadata keyed by identifier. Declaration order drives the settings
 * radio list, so keep it in the order operators should see. */
export const PAYMENT_PROVIDERS = {
  square: {
    checkoutFormOrigins: {
      live: squareCheckoutOrigins("squareup.com"),
      sandbox: squareCheckoutOrigins("squareupsandbox.com"),
    },
    currencies: null,
    label: "Square",
    // Square allows only 10 metadata entries of 255 characters each — the
    // tightest caps of any provider, and the reason small fields are packed
    // into one `b` entry (see packMetadata in payment-helpers.ts).
    metadata: { maxEntries: 10, maxValueLength: 255, packs: true },
    refundCapability: "keyed",
    secretField: "square_access_token",
    webhook: {
      domainChangeFixKey: "settings.domain_warning.square",
      signatureHeader: "x-square-hmacsha256-signature",
    },
  },
  stripe: {
    checkoutFormOrigins: { live: ["https://checkout.stripe.com"] },
    currencies: null,
    label: "Stripe",
    metadata: { maxEntries: 50, maxValueLength: 500, packs: false },
    refundCapability: "keyed",
    secretField: "stripe_secret_key",
    webhook: {
      domainChangeFixKey: "settings.domain_warning.stripe",
      signatureHeader: "stripe-signature",
    },
  },
  sumup: {
    // The docs return checkout.sumup.com; pay.sumup.com is also used, so the
    // policy allows both.
    checkoutFormOrigins: {
      live: ["https://checkout.sumup.com", "https://pay.sumup.com"],
    },
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
    refundCapability: "keyless",
    secretField: "sumup_api_key",
    webhook: null,
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
export const WEBHOOK_SIGNATURE_HEADERS: string[] = mapNotNullish(
  (id: PaymentProviderType) => PAYMENT_PROVIDERS[id].webhook?.signatureHeader,
)(PAYMENT_PROVIDER_IDS);

/** How one provider's webhook is wired, or null when it sends none. */
export const providerWebhook = (
  id: PaymentProviderType,
): PaymentProviderMeta["webhook"] => PAYMENT_PROVIDERS[id].webhook;

/** The origins one provider's hosted checkout posts to, in the environment
 * the site is set up for. A provider without its own sandbox checkout uses
 * its live origins in both. */
export const providerCheckoutFormOrigins = (
  id: PaymentProviderType,
  sandbox: boolean,
): readonly string[] => {
  // Read through the declared shape: `as const` narrows each entry to its own
  // literal, and only the declaration says a sandbox list is optional.
  const meta: PaymentProviderMeta = PAYMENT_PROVIDERS[id];
  const { live, sandbox: sandboxOrigins } = meta.checkoutFormOrigins;
  return sandbox && sandboxOrigins !== undefined ? sandboxOrigins : live;
};
