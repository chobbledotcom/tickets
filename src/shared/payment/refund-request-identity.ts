import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  paymentReferenceIndexInput,
  type TaggedPaymentReference,
} from "#shared/payment/provider-reference.ts";
import { requireRefundGeneration } from "#shared/payment/refund-generation.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Blind identity of one authorised refund generation. The provider-qualified
 * reference prevents cross-provider collisions; the generation makes an
 * owner's newly authorised attempt a different command. */
export const refundRequestIdentityIndex = (
  reference: TaggedPaymentReference,
  generation: number,
): Promise<string> => {
  requireRefundGeneration(generation);
  return hmacHash(
    `refund-request:1:${generation}:${paymentReferenceIndexInput(reference)}`,
  );
};

/** Blind replay identity of one provider callback session. */
export const refundCallbackReplayIndex = (
  provider: PaymentProviderType,
  sessionId: string,
): Promise<string> => {
  if (sessionId.trim().length === 0) {
    throw new Error("Refund callback session id must not be blank");
  }
  return hmacHash(`refund-callback:1:${provider}:${sessionId}`);
};
