/**
 * Whether an operation that moves or removes payment rows may go ahead. A
 * merge relocates them, a delete destroys them, and either way the rows may be
 * in the middle of something — money a run holds right now, or a decision the
 * owner has not made. Both writers ask here first.
 *
 * This module is pure: it decides from the records it is shown.
 */

import type { PaymentRowState } from "#shared/payment/row-state.ts";

/** What the operator is trying to do to the rows. */
export type RowMove = "delete" | "merge";

/** The one part of a row's record that is finished business: what it
 *  remembers about a payment that already ended, so it holds up nothing. */
type SettledField = "outcome";

/** Every other part is live work and has to say who it stops. Derived from
 *  the record, so a new kind of work is a compile error until it decides. */
type LiveWorkField = Exclude<keyof PaymentRowState, SettledField>;

type LiveWork = {
  /** Whether this row is in the middle of this work. */
  found: (state: PaymentRowState) => boolean;
  /** The plain word for it, for the consumers that cannot decrypt. */
  mirror: string;
  /** What to tell the operator, naming what to do next. */
  refusal: string;
  /** Which operations this work stops. */
  stops: Record<RowMove, boolean>;
};

/**
 * What a payment row can be in the middle of, and who each thing stops.
 *
 * A claim stops both writers fresh or stale: a stale one means a run died
 * holding this money and its record is the only sign the money may be going
 * back. The writers part company on an owner review — a merge relocates the
 * marker, so the review is still there afterwards, while a delete destroys the
 * promise that someone will look at this person's money.
 *
 * Claim first: money that may be moving now is the more urgent thing to say.
 */
const LIVE_WORK = {
  claim: {
    found: (state: PaymentRowState) => state.claim !== undefined,
    mirror: "claim",
    refusal:
      "A refund for this person is still in progress. Finish or re-run the refund, then try again.",
    stops: { delete: true, merge: true },
  },
  review: {
    found: (state: PaymentRowState) => state.review !== undefined,
    mirror: "review",
    refusal:
      "The owner still has to check a payment for this person. Mark it reviewed, then try again.",
    stops: { delete: true, merge: false },
  },
} satisfies Record<LiveWorkField, LiveWork>;

/** Why this move must not go ahead, or null when the rows are free. Most rows
 *  are in the middle of nothing, so that is an ordinary answer. */
export const moveRefusalOrNull = (
  states: readonly PaymentRowState[],
  move: RowMove,
): string | null => {
  const blocking = Object.values(LIVE_WORK).find(
    (work) => work.stops[move] && states.some(work.found),
  );
  return blocking === undefined ? null : blocking.refusal;
};

/** The plain word a row shows the consumers that cannot decrypt it — the
 *  prune and the orphan purge, both fixed-cost SQL. Every writer derives it
 *  from the record it stores, so a row whose claim is let go but whose review
 *  remains still reads as protected. Empty when nothing is live. */
export const mirrorFor = (state: PaymentRowState): string => {
  const work = Object.values(LIVE_WORK).find((entry) => entry.found(state));
  return work === undefined ? "" : work.mirror;
};
