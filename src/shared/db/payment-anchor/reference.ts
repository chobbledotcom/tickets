/** The encrypted reference and every blind spelling a legacy anchor checks. */

import {
  matchingPaymentReferenceIndexes,
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";

export interface PaymentAnchorReference {
  readonly matchingIndexes: readonly string[];
  readonly stored: StoredPaymentReference;
}

/** Prepare one payment reference for creation-, save-, or merge-time anchoring. */
export const paymentAnchorReference = async (
  payment: PaymentReference,
): Promise<PaymentAnchorReference> => {
  const [stored, matchingIndexes] = await Promise.all([
    storePaymentReference(payment),
    matchingPaymentReferenceIndexes(payment),
  ]);
  return { matchingIndexes, stored };
};
