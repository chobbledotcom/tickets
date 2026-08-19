import type { RefundPaymentReference } from "#db/payment-references.ts";
import type { RefundLedgerResult } from "#shared/refund-ledger/result.ts";

type IndexedRefundReference = Pick<RefundPaymentReference, "index">;

/** Build the exact reference outcome expected from a refund-ledger attempt. */
export const refundLedgerResult = (
  recorded: readonly IndexedRefundReference[],
  unrecorded: readonly IndexedRefundReference[] = [],
  review: readonly IndexedRefundReference[] = [],
): RefundLedgerResult => ({
  recorded: new Set(recorded.map(({ index }) => index)),
  reviewReferenceIndexes: new Set(review.map(({ index }) => index)),
  unrecorded: new Set(unrecorded.map(({ index }) => index)),
});
