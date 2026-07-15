/**
 * Why couldn't a staged booking be activated? The activation claim's UPDATE
 * only touches rows that are still the exact staged order (quantity 0, same
 * lines) with capacity and modifier stock to spare, so a refusal means one of
 * those gave way. This module answers which one — checked against the database
 * directly, so the answer stays right even when the change happened while the
 * claim was in flight.
 */

/* jscpd:ignore-start */
import type { CanonicalBooking } from "#shared/booking-lines.ts";
import { loadExistingLines } from "#shared/db/attendees/atomic-update.ts";
import { bookingSlotKey } from "#shared/db/attendees/booking-slot.ts";
import { bookingStartAt } from "#shared/db/attendees/capacity/range.ts";
import {
  anyModifierSoldOut,
  type ModifierUsage,
} from "#shared/db/modifier-usage.ts";
/* jscpd:ignore-end */

export type ActivationFailure =
  | "capacity_exceeded"
  | "sold_out"
  | "stage_active"
  | "stage_mismatch";

const expectedLineKey = (booking: CanonicalBooking): string =>
  bookingSlotKey(
    booking.listingId,
    bookingStartAt(booking),
    booking.parentListingId,
    booking.packageGroupId,
  );

/**
 * Check the staged rows are still exactly the order we are about to claim.
 * Returns the problem — "stage_active" when any row was already given a real
 * quantity outside this payment (the rows may be a live booking, so the caller
 * must hold the money for the operator rather than refund or re-claim), or
 * "stage_mismatch" when the booking lines changed (still all quantity 0, so
 * nothing is live and a refund is safe) — or null when the stage is untouched.
 *
 * Zero staged rows is an IMPOSSIBLE state, so it throws rather than returning a
 * reason: a pending stage and its rows are only ever removed together (every
 * attendee delete cascades the stage; the prune deletes both), admin
 * edits/merges/deletes are blocked while pending, and a listing can't be
 * deleted while it has a pending checkout. No rows here means a deletion path
 * skipped the stage cascade — a bug to surface, not to book fresh around.
 */
export const findStageProblem = async (
  attendeeId: number,
  bookings: CanonicalBooking[],
): Promise<Extract<
  ActivationFailure,
  "stage_active" | "stage_mismatch"
> | null> => {
  const existing = await loadExistingLines(attendeeId);
  if (existing.length === 0) {
    throw new Error(
      `Staged attendee ${attendeeId} has no booking rows at activation — a pending checkout stage must never be deleted while its payment can still land`,
    );
  }
  if (existing.some(({ booking }) => booking.quantity !== 0)) {
    return "stage_active";
  }
  const expected = bookings.map(expectedLineKey).toSorted();
  const actual = existing.map(({ key }) => key).toSorted();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : "stage_mismatch";
};

/**
 * The failure to report for a refused activation claim: a stage problem first
 * — a row flipped live or the lines changed, possibly while the claim was in
 * flight — then sold-out modifier stock, then plain capacity. A stage problem
 * must never classify as a refundable capacity failure: "stage_active" rows
 * may be a live booking whose money the operator must decide.
 */
export const refusalReason = async (
  attendeeId: number,
  bookings: CanonicalBooking[],
  usages: ModifierUsage[],
): Promise<ActivationFailure> => {
  const stageProblem = await findStageProblem(attendeeId, bookings);
  if (stageProblem) return stageProblem;
  return (await anyModifierSoldOut(usages)) ? "sold_out" : "capacity_exceeded";
};
