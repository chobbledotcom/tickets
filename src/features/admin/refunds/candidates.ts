import type { LoadedRefundAttendee } from "#db/payment-claim/take.ts";
import {
  getRefundPaymentReferences,
  type RefundReferenceProblem,
  stillWithTheProvider,
  type TaggedRefundPaymentReference,
  underRefundClaim,
} from "#db/payment-references.ts";
import { filter, requiredMapValue, uniqueBy } from "#fp";
import { type Attendee, hasTicketQuantity } from "#types";

type RefundCandidateAttendee = Pick<
  Attendee,
  "id" | "payment_id" | "pii_blob" | "quantity" | "refunded"
>;

export type RefundCandidate = {
  attendee: RefundCandidateAttendee;
  references: TaggedRefundPaymentReference[];
};

export type RefundCandidateSet =
  | { readonly candidates: RefundCandidate[]; readonly kind: "complete" }
  | RefundReferenceProblem;

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
  references: readonly TaggedRefundPaymentReference[],
): boolean =>
  !attendee.refunded ||
  stillWithTheProvider(references) ||
  underRefundClaim(references);

/** Attendees a refund run still has work for on this listing: a real ticket
 * line, at least one stored provider charge reference, and work remaining. */
export const getRefundCandidates = async (
  attendees: readonly RefundCandidateAttendee[],
  privateKey: CryptoKey,
): Promise<RefundCandidateSet> => {
  const ticketHolders = uniqueBy(
    (attendee: RefundCandidateAttendee) => attendee.id,
  )(filter<RefundCandidateAttendee>(hasTicketQuantity)([...attendees]));
  const referencesByAttendee = await getRefundPaymentReferences(
    ticketHolders.map((attendee) => ({
      currentPaymentId: attendee.payment_id,
      id: attendee.id,
    })),
    privateKey,
  );
  const referenceSets = ticketHolders.map((attendee) => ({
    attendee,
    set: requiredMapValue(
      referencesByAttendee,
      attendee.id,
      `Refund references omitted attendee ${attendee.id}`,
    ),
  }));
  const completeSets = referenceSets.flatMap(({ attendee, set }) =>
    set.kind === "complete" ? [{ attendee, references: set.references }] : [],
  );
  const refused = referenceSets.find(({ set }) => set.kind !== "complete");
  if (refused !== undefined && refused.set.kind !== "complete") {
    return { kind: refused.set.kind };
  }
  return {
    candidates: filter(
      (candidate: RefundCandidate) =>
        candidate.references.length > 0 &&
        refundWorkRemains(candidate.attendee, candidate.references),
    )(completeSets),
    kind: "complete",
  };
};
