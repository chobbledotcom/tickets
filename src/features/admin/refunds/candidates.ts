import { filter } from "#fp";
import {
  getRefundPaymentReferences,
  type RefundPaymentReference,
  stillWithTheProvider,
  underRefundClaim,
} from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";

export type RefundCandidate = {
  attendee: Attendee;
  references: RefundPaymentReference[];
};

/** Attendees a refund run still has work for on this listing: a real ticket
 * line, at least one stored provider charge reference, and either money still
 * with the provider or a hold a run left behind. */
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
      (!candidate.attendee.refunded ||
        stillWithTheProvider(candidate.references) ||
        // A run whose money went back but whose release write did not is the
        // only thing that can let its own hold go. Leaving such an attendee
        // out is what stranded them: refused by delete and by merge, and told
        // to re-run a refund that would never pick them up again.
        underRefundClaim(candidate.references)) &&
      hasTicketQuantity(candidate.attendee),
  )(
    attendees.map((attendee) => ({
      attendee,
      references: referencesByAttendee.get(attendee.id)!,
    })),
  );
};
