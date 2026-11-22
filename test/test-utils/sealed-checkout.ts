/** A checkout as our own code assembles it for a provider, for direct tests
 * of the record that the provider stores and of the order that is read back. */

import { priceCheckout } from "#shared/checkout-pricing.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { extractSessionMetadata } from "#shared/session-metadata.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";

/** The providers whose checkouts keep their order sealed in our database. */
export const CARD_PROVIDERS = ["stripe", "square"] as const;

/** Assemble the metadata of a checkout at its own price. Gives the entries
 * as the provider stores them (`wire`), and as the webhook reads them. */
export const withProof = async (
  intent: CheckoutIntent,
  provider: "stripe" | "square" | "sumup",
) => {
  const total = priceCheckout(intent).total;
  const wire = await assembleCheckoutMetadata(provider, intent, total);
  return { metadata: extractSessionMetadata(wireMetadata(wire)), total, wire };
};
