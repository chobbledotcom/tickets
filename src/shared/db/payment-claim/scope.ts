import { sortedNumbers } from "#fp";
import type { ClaimRequest } from "#payment/claim.ts";

type ScopedPaymentRow = {
  readonly referenceIndex: string;
  readonly sessionId: string;
};

/**
 * What claiming reads off an attendee: which one it is, and what its payment
 * references can match. A `LoadedRefundAttendee` carries more than this, and
 * fits; naming the narrower shape says which parts this decision rests on.
 */
export type ClaimableAttendee = {
  readonly attendeeId: number;
  readonly references: readonly {
    readonly matchingIndexes: readonly string[];
  }[];
};

/** Names every initiating attendee whose loaded reference matches this row. */
export const claimRequestFor = (
  attendees: readonly ClaimableAttendee[],
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
