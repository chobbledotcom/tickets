import { filter } from "#fp";
import {
  getRefundPaymentReferences,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";

export type RefundCandidate = {
  attendee: Attendee;
  references: RefundPaymentReference[];
};

/** Attendees refundable on this listing: a real ticket line, not already
 * refunded, and at least one stored provider charge reference. */
export const getRefundCandidates = async (
  attendees: Attendee[],
  privateKey: CryptoKey,
): Promise<RefundCandidate[]> => {
  const referencesByAttendee = await getRefundPaymentReferences(
    attendees,
    privateKey,
  );
  return filter(
    (candidate: RefundCandidate) =>
      candidate.references.length > 0 &&
      !candidate.attendee.refunded &&
      hasTicketQuantity(candidate.attendee),
  )(
    attendees.map((attendee) => ({
      attendee,
      references: referencesByAttendee.get(attendee.id)!,
    })),
  );
};
