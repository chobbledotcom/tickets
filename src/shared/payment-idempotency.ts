import { toBase64Url } from "#shared/crypto/utils.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/**
 * Stable refund idempotency key for a single provider payment. The same
 * provider-and-payment pair always produces the same key, so a retried
 * webhook redelivery of the same refund resolves to one provider-side refund
 * instead of a second charge-back. A different provider's refund for the same
 * payment reference hashes to a different key, so the two never collide.
 *
 * SHA-256 base64url is 43 characters, within each provider's idempotency-key
 * length limit.
 */
export const refundIdempotencyKey = async (
  provider: PaymentProviderType,
  paymentReference: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${provider}-refund:${paymentReference}`),
  );
  return toBase64Url(new Uint8Array(digest));
};
