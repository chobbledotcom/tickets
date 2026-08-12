import { filter, requiredMapValue, uniqueBy } from "#fp";
import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
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

/** The exact attendee revision and payment rows the claim must verify. */
export const loadedRefundAttendee = (
  candidate: RefundCandidate,
): LoadedRefundAttendee => ({
  attendeeId: candidate.attendee.id,
  loadedPiiBlob: candidate.attendee.pii_blob,
  references: candidate.references,
});

/**
 * Whether a refund run still has work for this attendee.
 *
 * Money still with the provider is the obvious kind. A hold a run left behind
 * is the other: nothing else in the system can take one off, so an attendee
 * whose money is all back but whose row is still held has to be picked up
 * again — and until they are, their delete and their merge stay refused.
 *
 * The bulk list and the single-attendee page both ask this, so the page a
 * person is looking at and the run they start cannot disagree about whether
 * there is anything left to do.
 */
export const refundWorkRemains = (
  attendee: Pick<Attendee, "refunded">,
  references: readonly RefundPaymentReference[],
): boolean =>
  !attendee.refunded ||
  stillWithTheProvider(references) ||
  underRefundClaim(references);

/** Attendees a refund run still has work for on this listing: a real ticket
 * line, at least one stored provider charge reference, and work remaining. */
export const getRefundCandidates = async (
  attendees: Attendee[],
  privateKey: CryptoKey,
): Promise<RefundCandidate[]> => {
  const ticketHolders = uniqueBy((attendee: Attendee) => attendee.id)(
    filter<Attendee>(hasTicketQuantity)(attendees),
  );
  const referencesByAttendee = await getRefundPaymentReferences(
    ticketHolders,
    privateKey,
  );
  return filter(
    (candidate: RefundCandidate) =>
      candidate.references.length > 0 &&
      refundWorkRemains(candidate.attendee, candidate.references),
  )(
    ticketHolders.map((attendee) => ({
      attendee,
      references: requiredMapValue(
        referencesByAttendee,
        attendee.id,
        `Refund references omitted attendee ${attendee.id}`,
      ),
    })),
  );
};
