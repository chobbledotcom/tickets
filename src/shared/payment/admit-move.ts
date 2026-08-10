/**
 * Whether an operation that moves or removes payment rows may go ahead.
 *
 * A merge relocates an attendee's payment rows onto someone else; a delete
 * destroys them. Either way those rows may be in the middle of something — money
 * a refund run is holding right now, or a decision the owner has not made yet —
 * and carrying on over that is how a refund gets sent from under a run, or how
 * the only sign that money is owed disappears. So both writers ask here first,
 * and a refusal says what to do about it.
 *
 * This module is pure: it decides from the records it is shown.
 */

import type { PaymentRowState } from "#shared/payment/row-state.ts";

/** What the operator is trying to do to the rows. */
export type RowMove = "delete" | "merge";

/**
 * The one part of a row's record that is finished business rather than live
 * work. A terminal outcome is what the row remembers about a payment that has
 * already ended, so it never holds up a merge or a delete.
 */
type SettledField = "outcome";

/** Every other part of the record is live work, and has to say who it stops.
 *  Deriving the list from the record means a new kind of work on a row is a
 *  compile error here until someone decides which writers it blocks. */
type LiveWorkField = Exclude<keyof PaymentRowState, SettledField>;

type LiveWork = {
  /** Whether this row is in the middle of this work. */
  found: (state: PaymentRowState) => boolean;
  /** What to tell the operator, naming what to do next. */
  refusal: string;
  /** Which operations this work stops. */
  stops: Record<RowMove, boolean>;
};

/**
 * What a payment row can be in the middle of, and who each thing stops.
 *
 * A claim stops both writers whether it is fresh or stale. A stale one means a
 * refund run died holding this money, and its record is the only sign the money
 * may already be going back — moving or destroying the row loses that. The fix
 * is the same either way, so the wording is too.
 *
 * The two writers part company on an owner review. A merge RELOCATES: the
 * marker rides the moved row onto the merged person, and the review is still
 * there to do afterwards. A delete DESTROYS, and a review marker is the promise
 * that someone will look at this person's money, so it waits for the owner.
 *
 * Claim first: money that may be moving right now is the more urgent thing to
 * say when a row carries both.
 */
const LIVE_WORK = {
  claim: {
    found: (state: PaymentRowState) => state.claim !== undefined,
    refusal:
      "A refund for this person is still in progress. Finish or re-run the refund, then try again.",
    stops: { delete: true, merge: true },
  },
  review: {
    found: (state: PaymentRowState) => state.review !== undefined,
    refusal:
      "The owner still has to check a payment for this person. Mark it reviewed, then try again.",
    stops: { delete: true, merge: false },
  },
} satisfies Record<LiveWorkField, LiveWork>;

/**
 * Why this move must not go ahead, or null when the rows are free.
 *
 * Most rows are in the middle of nothing, so "nothing is holding these up" is
 * an ordinary answer and is reported rather than thrown.
 */
export const moveRefusalOrNull = (
  states: readonly PaymentRowState[],
  move: RowMove,
): string | null => {
  const blocking = Object.values(LIVE_WORK).find(
    (work) => work.stops[move] && states.some(work.found),
  );
  return blocking === undefined ? null : blocking.refusal;
};
