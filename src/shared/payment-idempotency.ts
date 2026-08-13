import { toBase64Url } from "#shared/crypto/utils.ts";
import { requireRefundGeneration } from "#shared/payment/refund-generation.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/**
 * Stable idempotency key for one durable refund generation. The same provider,
 * payment, and generation always produce the same key, while a later generation
 * or another provider cannot collide with it.
 *
 * SHA-256 base64url is 43 characters, within each provider's idempotency-key
 * length limit.
 */
export const refundIdempotencyKey = async (
  provider: PaymentProviderType,
  paymentReference: string,
  generation: number,
): Promise<string> => {
  requireRefundGeneration(generation);
  // Generation one's established key space must remain stable across deploys.
  const generationSuffix = generation === 1 ? "" : `:${generation}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${provider}-refund:${paymentReference}${generationSuffix}`,
    ),
  );
  return toBase64Url(new Uint8Array(digest));
};
