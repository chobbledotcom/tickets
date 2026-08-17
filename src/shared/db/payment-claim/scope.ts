import type { LoadedRefundAttendee } from "#shared/db/payment-claim/take.ts";
import type { ClaimRequest } from "#shared/payment/claim.ts";

type ScopedPaymentRow = {
  readonly referenceIndex: string;
  readonly sessionId: string;
};

const sortedUniqueIds = (ids: readonly number[]): number[] =>
  [...new Set(ids)].sort((left, right) => left - right);

/** Names every initiating attendee whose loaded reference matches this row. */
export const claimRequestFor = (
  attendees: readonly LoadedRefundAttendee[],
  row: ScopedPaymentRow,
): ClaimRequest => {
  const attendeeIds = sortedUniqueIds(
    attendees.flatMap((attendee) =>
      attendee.references.some((reference) =>
        reference.matchingIndexes.includes(row.referenceIndex),
      )
        ? [attendee.attendeeId]
        : [],
    ),
  );
  if (attendeeIds.length === 0) {
    throw new Error("Payment row matched no initiating attendee");
  }
  return { attendeeIds, scope: "attendee_set" };
};
