import type { LoadedRefundAttendee } from "#db/payment-claim/take.ts";
import { sortedNumbers } from "#fp";
import type { ClaimRequest } from "#payment/claim.ts";

type ScopedPaymentRow = {
  readonly referenceIndex: string;
  readonly sessionId: string;
};

/** Names every initiating attendee whose loaded reference matches this row. */
export const claimRequestFor = (
  attendees: readonly LoadedRefundAttendee[],
  row: ScopedPaymentRow,
): ClaimRequest => {
  const attendeeIds = sortedNumbers(
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
