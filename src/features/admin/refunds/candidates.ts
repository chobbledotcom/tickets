import { filter } from "#fp";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import type { RefundPaymentReference } from "#shared/payment-refund-reference.ts";
import {
  getPaymentRefundTargets,
  type PaymentRefundTarget,
  refundReferences,
} from "#shared/payment-runtime/refund-targets.ts";
import type { Attendee } from "#shared/types.ts";
import { hasTicketQuantity } from "#shared/types.ts";

export type RefundCandidate = {
  attendee: Attendee;
  references: RefundPaymentReference[];
  targets: PaymentRefundTarget[];
};

export const refundCandidatePayments = (
  candidates: readonly RefundCandidate[],
): PaymentSession[] =>
  candidates.flatMap((candidate) =>
    candidate.targets.map(({ payment }) => payment),
  );

export const getRefundCandidates = async (
  attendees: Attendee[],
): Promise<RefundCandidate[]> => {
  const targetsByAttendee = await getPaymentRefundTargets(
    attendees.map((attendee) => attendee.id),
  );
  return filter(
    (candidate: RefundCandidate) =>
      candidate.references.some((reference) => !reference.providerRefunded) &&
      !candidate.attendee.refunded &&
      hasTicketQuantity(candidate.attendee),
  )(
    attendees.map((attendee) => {
      const targets = targetsByAttendee.get(attendee.id) ?? [];
      return { attendee, references: refundReferences(targets), targets };
    }),
  );
};
