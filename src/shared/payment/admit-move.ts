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
  /** Where this comes in the order things are said when a row carries more
   *  than one, lowest first. Declared per entry because the order the fields
   *  are written in belongs to the formatter, which sorts them alphabetically
   *  — so a rename could otherwise reorder what an operator is told. */
  saidFirst: number;
  /** Which operations this work stops. */
  stops: Record<RowMove, boolean>;
};

/**
 * What a payment row can be in the middle of, and who each thing stops.
 *
 * A claim stops both writers fresh or stale: a stale one means a run died
 * holding this money and its record is the only sign the money may be going
 * back. The other two part company — a merge RELOCATES, so the marker rides
 * the moved row and the work is still there to do afterwards, while a delete
 * DESTROYS the row the correction needs.
 *
 * `saidFirst` puts the most urgent one first when a row carries more than one:
 * money that may be moving right now, then money that moved and is not on the
 * books, then money somebody should look at.
 */
const LIVE_WORK = {
  claim: {
    found: (state: PaymentRowState) => state.claim !== undefined,
    mirror: "claim",
    refusal:
      "A refund for this person is still in progress. Finish or re-run the refund, then try again.",
    saidFirst: 0,
    stops: { delete: true, merge: true },
  },
  review: {
    found: (state: PaymentRowState) => state.review !== undefined,
    mirror: "review",
    refusal:
      "The owner still has to check a payment for this person. Mark it reviewed, then try again.",
    saidFirst: 2,
    stops: { delete: true, merge: false },
  },
  unrecorded: {
    found: (state: PaymentRowState) => state.unrecorded !== undefined,
    mirror: "unrecorded",
    refusal:
      "This person's money went back, but the accounts do not show it. Record it, then try again.",
    saidFirst: 1,
    stops: { delete: true, merge: false },
  },
} satisfies Record<LiveWorkField, LiveWork>;

/** The word a row a refund run is holding shows in `protected_state`. Named
 *  here because this is where the word is decided, and read by the SQL guards
 *  that have to ask without decrypting the record. */
export const CLAIM_MIRROR: string = LIVE_WORK.claim.mirror;

/** Every kind of live work, most urgent first. Built once from the table's own
 *  `saidFirst`, so both readers below agree and neither depends on the order
 *  the fields happen to be written in. */
const WORST_FIRST: readonly LiveWork[] = Object.values(LIVE_WORK).sort(
  (one, other) => one.saidFirst - other.saidFirst,
);

/** Why this move must not go ahead, or null when the rows are free. Most rows
 *  are in the middle of nothing, so that is an ordinary answer. */
export const moveRefusalOrNull = (
  states: readonly PaymentRowState[],
  move: RowMove,
): string | null => {
  const blocking = WORST_FIRST.find(
    (work) => work.stops[move] && states.some(work.found),
  );
  return blocking === undefined ? null : blocking.refusal;
};

/** The plain word a row shows the consumers that cannot decrypt it — the
 *  prune and the orphan purge, both fixed-cost SQL. Every writer derives it
 *  from the record it stores, so a row whose claim is let go but whose review
 *  remains still reads as protected. Empty when nothing is live. */
export const mirrorFor = (state: PaymentRowState): string => {
  const work = WORST_FIRST.find((entry) => entry.found(state));
  return work === undefined ? "" : work.mirror;
};
