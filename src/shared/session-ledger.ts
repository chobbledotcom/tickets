/** What the ledger already records for a booking session (keyed on its event group). */
export type BookingLedgerDisposition =
  | { status: "unrecorded" }
  | { status: "booked"; attendeeId: number }
  | { status: "orphaned" };

/** Classify stored ledger legs and their current booking owner. */
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition =>
  !hasLegs
    ? { status: "unrecorded" }
    : ownerAttendeeId === null
      ? { status: "orphaned" }
      : { attendeeId: ownerAttendeeId, status: "booked" };
