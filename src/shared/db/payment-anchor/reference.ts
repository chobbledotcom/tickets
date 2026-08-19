/** The encrypted reference and every blind spelling an anchor checks. */

import {
  matchingPaymentReferenceIndexes,
  type StoredPaymentReference,
  storePaymentReference,
} from "#db/payment-reference-store.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";

export interface PaymentAnchorReference {
  readonly matchingIndexes: readonly string[];
  readonly stored: StoredPaymentReference;
}

/** Prepare one provider-proved payment for attendee creation. */
export const paymentAnchorReference = async (
  payment: TaggedPaymentReference,
): Promise<PaymentAnchorReference> => {
  const [stored, matchingIndexes] = await Promise.all([
    storePaymentReference(payment),
    matchingPaymentReferenceIndexes(payment),
  ]);
  return { matchingIndexes, stored };
};
