import { hmacHash } from "#shared/crypto/hashing.ts";
import { execute } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const referenceIndex = (
  provider: PaymentProviderType,
  paymentReference: string,
) => hmacHash(`refund:${provider}:${paymentReference}`);

/** Claim the only automatic submission allowed for a non-idempotent refund. */
export const claimPaymentRefundAttempt = async (
  provider: PaymentProviderType,
  paymentReference: string,
): Promise<boolean> => {
  const result = await execute(
    `INSERT OR IGNORE INTO payment_refund_attempts
       (reference_index, provider, started_at) VALUES (?, ?, ?)`,
    [await referenceIndex(provider, paymentReference), provider, nowIso()],
  );
  return result.rowsAffected === 1;
};

/** Allow another submission only after the provider authoritatively rejected it. */
export const releasePaymentRefundAttempt = async (
  provider: PaymentProviderType,
  paymentReference: string,
): Promise<void> => {
  await execute(
    "DELETE FROM payment_refund_attempts WHERE reference_index = ? AND provider = ?",
    [await referenceIndex(provider, paymentReference), provider],
  );
};
