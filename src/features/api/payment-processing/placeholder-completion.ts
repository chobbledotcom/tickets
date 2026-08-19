/**
 * Finish the money records for a stored quantity-0 placeholder whose payment
 * came back: post the ledger legs, complete the authority's local recording,
 * write the note and activity line exactly once, and let go of the row.
 *
 * Every step is safe to run again — the legs replay by identity, a recorded
 * authority tolerates its stale receipt, the confirmation latch turns replays
 * into one write, and the settle only touches the exact hold — so a delivery
 * can crash anywhere and a later one finishes the job from that point.
 */

import { logActivity } from "#db/activity-log.ts";
import { withTransaction } from "#db/client.ts";
import { createSystemNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import { type RowSettlement, settleAttendeeRows } from "#db/payment-claim.ts";
import { insertRefundConfirmation } from "#db/refund-confirmations.ts";
import {
  type PlaceholderRefund,
  placeholderRefundNote,
} from "#payment/placeholder-refund.ts";
import type { PaymentBooksChange } from "#payment/row-transitions.ts";
import {
  type RefundAuthorityReceipt,
  recordProviderRefunds,
} from "#shared/provider-refunds.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger/placeholder.ts";

/** The durable facts that name one placeholder's money work — every one
 * re-derivable from stored rows, so a resumed delivery can rebuild them. */
export interface PlaceholderMoneyTarget {
  readonly attendeeId: number;
  readonly listingId: number;
  /** The business time the money moved — must be the same on every run. */
  readonly occurredAt: string;
  readonly referenceIndexes: readonly string[];
  readonly sessionId: string;
  readonly settlement: RowSettlement;
  readonly spec: PlaceholderRefund;
}

export interface PlaceholderMoneyCompletion extends PlaceholderMoneyTarget {
  readonly activityMessage: string;
  readonly amount: number;
  /** The authority still owing its local recording, or null once recorded. */
  readonly dueAuthority: RefundAuthorityReceipt | null;
  /** What a ledger miss does: fail the delivery so the provider redelivers,
   * or keep the row saying "unrecorded" for the refresh route. */
  readonly onLedgerMiss: "throw" | "mark_unrecorded";
}

const settledWithBooks = (
  settlement: RowSettlement,
  books: PaymentBooksChange,
): RowSettlement => ({
  ...settlement,
  rows: new Map(
    [...settlement.rows].map(([sessionId, change]) => [
      sessionId,
      { ...change, books },
    ]),
  ),
});

/** Write the note and activity line exactly once across every run. */
const confirmOnce = async (
  completion: PlaceholderMoneyCompletion,
): Promise<void> =>
  await withTransaction(async (tx) => {
    const written = await insertRefundConfirmation(tx, {
      attendeeId: completion.attendeeId,
      referenceIndexes: completion.referenceIndexes,
    });
    if (written.kind === "current") return;
    await createSystemNote(
      attendeeNotes(completion.attendeeId),
      placeholderRefundNote(completion.attendeeId, completion.spec, true),
      { key: written.identity, purpose: "refund_confirmation" },
      tx,
    );
    await logActivity(
      completion.activityMessage,
      completion.listingId,
      completion.attendeeId,
      tx,
    );
  });

export const completePlaceholderMoney = async (
  completion: PlaceholderMoneyCompletion,
): Promise<{ posted: boolean }> => {
  const recording = await recordPlaceholderRefund(
    {
      amount: completion.amount,
      attendeeId: completion.attendeeId,
      eventId: completion.sessionId,
      listingId: completion.listingId,
      occurredAt: completion.occurredAt,
    },
    completion.spec.code,
    true,
  );
  if (!recording.posted) {
    if (completion.onLedgerMiss === "throw") {
      throw new Error(
        `Money for session ${completion.sessionId} could not be recorded`,
      );
    }
    // The money is back but the books missed it: the row keeps saying so,
    // and the authority stays due — both point at the refresh route.
    await settleAttendeeRows(
      settledWithBooks(completion.settlement, "unrecorded"),
    );
    return recording;
  }
  if (completion.dueAuthority !== null) {
    await recordProviderRefunds([completion.dueAuthority]);
  }
  await confirmOnce(completion);
  await settleAttendeeRows(settledWithBooks(completion.settlement, "recorded"));
  return recording;
};
