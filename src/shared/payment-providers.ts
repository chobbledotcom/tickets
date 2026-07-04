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

import type { PaymentProviderType } from "#shared/types.ts";

export type PaymentProviderMeta = {
  /** Human-readable display name — radio label and prose. */
  readonly label: string;
  /** Request header carrying the webhook signature, or null for providers whose
   * webhooks are unsigned (authenticity is re-established via the provider API
   * instead — see `PaymentProvider.requiresWebhookSignature`). */
  readonly webhookSignatureHeader: string | null;
};

/** Provider metadata keyed by identifier. Declaration order drives the settings
 * radio list, so keep it in the order operators should see. */
export const PAYMENT_PROVIDERS: Record<
  PaymentProviderType,
  PaymentProviderMeta
> = {
  square: {
    label: "Square",
    webhookSignatureHeader: "x-square-hmacsha256-signature",
  },
  stripe: { label: "Stripe", webhookSignatureHeader: "stripe-signature" },
  sumup: { label: "SumUp", webhookSignatureHeader: null },
};

/** Provider ids in declared order. */
export const PAYMENT_PROVIDER_IDS = Object.keys(
  PAYMENT_PROVIDERS,
) as PaymentProviderType[];

/** Webhook signature headers of every provider that signs its webhooks. */
export const WEBHOOK_SIGNATURE_HEADERS = PAYMENT_PROVIDER_IDS.map(
  (id) => PAYMENT_PROVIDERS[id].webhookSignatureHeader,
).filter((header): header is string => header !== null);
