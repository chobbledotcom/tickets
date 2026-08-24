/** Find the anchor rows a payment's money work could still be sitting on. */

import { inPlaceholders, queryAllPrimary } from "#db/client.ts";
import {
  asPaymentRowRecord,
  type PaymentRowRecord,
  paymentClaimRowsSql,
  type StoredPaymentClaimRow,
} from "#db/payment-claim.ts";
import { matchingPaymentReferenceIndexes } from "#db/payment-reference-store.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";

/** One anchor row with the joined authority's plain state word, so a resume
 * can tell "money known returned" from "refund still underway" in one read. */
export interface AnchorRowWork {
  readonly record: PaymentRowRecord;
  readonly refundStateName: string | null;
}

/**
 * Every durable anchor row for this payment, by any blind spelling of its
 * reference, decoded with its held work and the authority's state. Reads the
 * primary: a resume acts on what it finds, so a lagging replica must not hide
 * a row another delivery just wrote. Only `legacy:` anchor rows match — the
 * session's own idempotency row never carries anchor work.
 */
export const loadAnchorRowWork = async (
  payment: TaggedPaymentReference,
): Promise<AnchorRowWork[]> => {
  const indexes = await matchingPaymentReferenceIndexes(payment);
  const rows = await queryAllPrimary<StoredPaymentClaimRow>(
    paymentClaimRowsSql(
      `payment.payment_session_id LIKE 'legacy:%'
           AND payment.payment_reference_index IN (${inPlaceholders(indexes)})`,
    ),
    [...indexes],
  );
  return Promise.all(
    rows.map(async (row) => ({
      record: await asPaymentRowRecord(row),
      refundStateName: row.refund_state_name,
    })),
  );
};
