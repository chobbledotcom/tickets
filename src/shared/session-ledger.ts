/**
 * Ledger preflight for a payment session.
 *
 * The transfers ledger — not the prunable `processed_payments` idempotency row —
 * is the durable record of whether a paid session was already honoured. So
 * before anything that moves money for a session (creating a booking, settling a
 * balance, refunding one), the payment machine consults the ledger here and acts
 * on a typed verdict rather than re-deriving an ad-hoc check at each site:
 *
 *  - `unrecorded` — the ledger holds no legs for this booking event, so the
 *    session has never been honoured: process it fresh.
 *  - `booked`     — a live booking still owns the event group, so the ticket
 *    exists: replay it, never re-book or refund it.
 *  - `orphaned`   — legs exist but no live booking owns them (an operator deleted
 *    the attendee, leaving the ledger rows; or it was a refunded quantity-0
 *    placeholder): the money is already accounted for, so neither refund again
 *    nor recreate — acknowledge as already handled.
 *
 * The classification is split into a PURE decision function ({@link
 * classifyBookingLedger}) over the two facts the ledger yields and a thin IO
 * loader ({@link bookingLedgerDisposition}) that fetches them, so the decision
 * table is unit-testable on its own and the same shape can back other money
 * events.
 */

import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { eventGroupHasLegs } from "#shared/accounting/queries.ts";
import { attendeeIdByLedgerEventGroup } from "#shared/db/attendees.ts";

/** What the ledger already records for a booking session (keyed on its event group). */
export type BookingLedgerDisposition =
  | { status: "unrecorded" }
  | { status: "booked"; attendeeId: number }
  | { status: "orphaned" };

/**
 * Classify a booking event from the two facts the ledger yields: whether any
 * legs are stored for it, and which live booking (if any) still owns the event
 * group. Pure — no IO — so the booked/orphaned/unrecorded decision is exercised
 * directly by table-driven tests.
 */
export const classifyBookingLedger = (
  hasLegs: boolean,
  ownerAttendeeId: number | null,
): BookingLedgerDisposition =>
  !hasLegs
    ? { status: "unrecorded" }
    : ownerAttendeeId === null
      ? { status: "orphaned" }
      : { attendeeId: ownerAttendeeId, status: "booked" };

/**
 * Load a booking session's ledger facts and classify them. `eventId` is the
 * booking's stable event id — the payment session id on the paid path. The owner
 * lookup is skipped when no legs exist (the common fresh-session case), so an
 * unrecorded session costs a single existence probe.
 */
export const bookingLedgerDisposition = async (
  eventId: string,
): Promise<BookingLedgerDisposition> => {
  const group = await bookingEventGroup(eventId);
  const hasLegs = await eventGroupHasLegs(group);
  const owner = hasLegs ? await attendeeIdByLedgerEventGroup(group) : null;
  return classifyBookingLedger(hasLegs, owner);
};
