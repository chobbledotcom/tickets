/**
 * The money an attendee update carries: the full list of payments received
 * and the full list of named adjustments, in the shape the create takes.
 * A leg's reference names the attendee and the receipt's place in its list.
 * A list that repeats an earlier one therefore derives references that are
 * already stored.
 */

import { eventGroup } from "#accounting/refs.ts";
import { byColumnIn, selectTransfers } from "#accounting/rows.ts";
import { queryBatchPrimary } from "#db/client.ts";
import {
  type CreateReceipts,
  receiptContext,
  receiptLegs,
} from "#shared/checkout-complete.ts";
import { legIdentityDiff } from "#shared/ledger/reconcile.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The name of the receipt at one place of the combined leg list: payments
 *  first, then adjustments. */
const receiptName = (receipts: CreateReceipts, position: number): string => {
  const paid = receipts.payments.length;
  return position < paid
    ? `payments[${position}]`
    : `adjustments[${position - paid}]`;
};

/** The refusal for a receipt that is already stored as different money, or
 *  null when the stored leg is the same money. The stored time stands in for
 *  the new one, so only the money is compared. */
const storedReceiptConflict = (
  name: string,
  stored: Transfer,
  leg: TransferInput,
): string | null => {
  const differs = legIdentityDiff(stored, {
    ...leg,
    occurredAt: stored.occurredAt,
  });
  return differs.length === 0
    ? null
    : `${name} is already recorded with a different ${differs.join(", ")}`;
};

/** The receipt legs still to post, or the refusal for a receipt that is
 *  already recorded as different money. Each new receipt is its own event, so
 *  the booking's stored event never changes. A receipt that is already stored
 *  as the same money adds nothing. */
export const newReceiptLegs = async (
  attendeeId: number,
  receipts: CreateReceipts,
): Promise<Result<TransferInput[]>> => {
  const legs = await receiptLegs(
    receiptContext(attendeeId),
    receipts,
    (kind, index) => eventGroup(["api-receipt", attendeeId, kind, index]),
  );
  const stored = new Map(
    (
      await selectTransfers(
        queryBatchPrimary,
        byColumnIn(
          "reference",
          legs.map((leg) => leg.reference),
        ),
      )
    ).map((transfer) => [transfer.reference, transfer]),
  );
  const fresh: TransferInput[] = [];
  for (const [position, leg] of legs.entries()) {
    const prior = stored.get(leg.reference);
    if (prior === undefined) {
      fresh.push(leg);
      continue;
    }
    const conflict = storedReceiptConflict(
      receiptName(receipts, position),
      prior,
      leg,
    );
    if (conflict !== null) return errorResult(conflict);
  }
  return okResult(fresh);
};
