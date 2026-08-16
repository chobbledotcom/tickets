/** The only ways one payment row's stored record changes.
 *
 * A row's slot carries up to three pieces of live work — a refund run's
 * claim, an owner review, and returned money the books do not show — plus,
 * on a row with no live work, the terminal outcome of its checkout. These
 * pure functions are the complete set of moves; the database layer only
 * wraps them in the compare-and-swap statement that makes them stick. */

import type { ClaimRequest } from "#shared/payment/claim.ts";
import {
  openPaymentReview,
  type PaymentReviewReason,
} from "#shared/payment/review.ts";
import type {
  PaymentRowState,
  RefundClaim,
  RefundClaimPhase,
  StoredPaymentFailure,
} from "#shared/payment/row-state.ts";

export type PaymentReviewChange =
  | { readonly kind: "review"; readonly reason: PaymentReviewReason }
  | {
      readonly kind: "resolved";
      readonly reason: PaymentReviewReason["kind"];
    };

export type PaymentBooksChange = "recorded" | "unrecorded";

/** Every change one run can make to one exact row. Omitted facts are
 * preserved; no absence silently clears an older repair target. */
export type PaymentRowSettlement = {
  readonly books?: PaymentBooksChange;
  readonly claim: "release";
  readonly phase: RefundClaimPhase;
  readonly review?: PaymentReviewChange;
};

/** The exact hold a settling or confirming run says it owns. */
export type HeldRowClaim = {
  readonly commandId: string;
  readonly heldSince: string;
  readonly phase: RefundClaimPhase;
};

/** Build the one canonical checking fence for an attendee set. */
export const checkingClaimFor = (
  request: ClaimRequest,
  commandId: string,
  writtenAt: string,
): RefundClaim => ({
  attendeeIds: [...request.attendeeIds],
  commandId,
  phase: "checking",
  scope: request.scope,
  writtenAt,
});

/** Whether the row's claim is exactly the hold this run wrote. */
export const claimHeldBy = (
  claim: RefundClaim | undefined,
  held: HeldRowClaim,
): boolean =>
  claim !== undefined &&
  claim.commandId === held.commandId &&
  claim.writtenAt === held.heldSince &&
  claim.phase === held.phase;

/** Put a run's fence on the row. Overwrites an existing claim on purpose:
 * the take path only reaches this after `decideClaim` admits the hold, and
 * an admitted stale hold is resumed by replacing its fence. */
export const grantClaim = (
  state: PaymentRowState,
  claim: RefundClaim,
): PaymentRowState => ({ ...state, claim });

/** Put on or take off the row's books-behind word without disturbing its
 * other state. A retry keeps the date the first failed ledger write stored. */
const withBooksChange = (
  state: PaymentRowState,
  change: PaymentBooksChange | undefined,
  returnedAt: string,
): PaymentRowState => {
  if (change === undefined) return state;
  const { unrecorded: _was, ...kept } = state;
  if (change === "recorded") return kept;
  return {
    ...kept,
    unrecorded:
      state.unrecorded === undefined ? { returnedAt } : state.unrecorded,
  };
};

/** Apply only the review decision this run made, preserving it when the run
 * made none. */
const withReviewChange = (
  state: PaymentRowState,
  change: PaymentReviewChange | undefined,
): PaymentRowState => {
  if (change === undefined) return state;
  if (
    change.kind === "resolved" &&
    state.review?.reason.kind !== change.reason
  ) {
    return state;
  }
  if (
    change.kind === "review" &&
    state.review?.reason.kind === change.reason.kind
  ) {
    return state;
  }
  const { review: _was, ...kept } = state;
  return change.kind === "resolved"
    ? kept
    : { ...kept, review: openPaymentReview(change.reason) };
};

const releaseClaim = (state: PaymentRowState): PaymentRowState => {
  const { claim: _released, ...kept } = state;
  return kept;
};

/** The full per-row settle a run makes under its hold: the books word, the
 * review decision, then the fence comes off. Null when this settlement does
 * not hold the row — the caller leaves such a row untouched, so a run that
 * stalled past the staleness cutoff cannot strip the live claim off work
 * another run has since resumed. */
export const settledRowState = (
  state: PaymentRowState,
  change: PaymentRowSettlement,
  held: { readonly commandId: string; readonly heldSince: string },
  returnedAt: string,
): PaymentRowState | null =>
  claimHeldBy(state.claim, { ...held, phase: change.phase })
    ? releaseClaim(
        withReviewChange(
          withBooksChange(state, change.books, returnedAt),
          change.review,
        ),
      )
    : null;

/** The terminal outcome of a checkout that ended. Throws on any live work —
 * the pure form of the SQL fence that only lets an outcome land on an empty
 * slot, so a settled word can never bury a claim, a review, or unrecorded
 * money. */
export const withOutcome = (
  state: PaymentRowState,
  failure: StoredPaymentFailure,
): PaymentRowState => {
  if (
    state.claim !== undefined ||
    state.review !== undefined ||
    state.unrecorded !== undefined
  ) {
    throw new Error("A terminal outcome cannot land on live payment work");
  }
  return { outcome: failure };
};
