import { toBase64Url } from "#shared/crypto/utils.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Stable provider refund key. SHA-256 base64url is 43 characters, within each
 * provider's idempotency-key limit. */
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
