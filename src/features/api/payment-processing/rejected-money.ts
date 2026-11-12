import type { RowSettlement } from "#db/payment-claim.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  loadRefundAuthorityById,
  type RefundAuthorityRow,
} from "#db/provider-refund-authority.ts";
import type { PlaceholderRefund } from "#payment/placeholder-refund.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
import type { ReturnedRejectionReceipt } from "#routes/api/payment-processing/refunds.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { requireValue } from "#shared/required-value.ts";

export const readRejectedAuthority = async (
  returned: ReturnedRejectionReceipt,
  sessionId: string,
): Promise<RefundAuthorityRow> =>
  requireValue(
    await loadRefundAuthorityById(returned.authority.id),
    `Rejected session ${sessionId} lost its refund authority`,
  );

/** Fresh and resumed refunds must use the same money records. */
export const completeRejectedMoney =
  (facts: {
    readonly authority: RefundAuthorityRow;
    readonly intent: Pick<BookingIntent, "items">;
    readonly reference: TaggedPaymentReference;
    readonly returned: ReturnedRejectionReceipt;
    readonly sessionId: string;
    readonly spec: PlaceholderRefund;
  }) =>
  async (target: {
    readonly attendeeId: number;
    readonly occurredAt: string;
    readonly settlement: RowSettlement;
  }): Promise<void> => {
    await completePlaceholderMoney({
      activityMessage: `Automatic refund (${facts.spec.code}); rejected payment kept at quantity 0`,
      amount: facts.authority.captured.amount,
      attendeeId: target.attendeeId,
      dueAuthority:
        facts.returned.local === "due" ? facts.returned.authority : null,
      listingId: facts.intent.items[0]!.e,
      occurredAt: target.occurredAt,
      onLedgerMiss: "throw",
      referenceIndexes: [await paymentReferenceIndex(facts.reference)],
      sessionId: facts.sessionId,
      settlement: target.settlement,
      spec: facts.spec,
    });
  };
