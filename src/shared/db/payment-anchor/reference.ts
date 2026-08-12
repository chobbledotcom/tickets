/** The encrypted reference and every blind spelling a legacy anchor checks. */

import {
  matchingPaymentReferenceIndexes,
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";

export interface PaymentAnchorReference {
  readonly matchingIndexes: readonly string[];
  readonly stored: StoredPaymentReference;
}

/** Prepare one PII-only payment for either save-time or merge-time anchoring. */
export const paymentAnchorReference = async (
  paymentId: string,
): Promise<PaymentAnchorReference> => {
  const payment = { kind: "untagged", reference: paymentId } as const;
  const [stored, matchingIndexes] = await Promise.all([
    storePaymentReference(payment),
    matchingPaymentReferenceIndexes(payment),
  ]);
  return { matchingIndexes, stored };
};
