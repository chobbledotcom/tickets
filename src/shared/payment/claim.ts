/**
 * Who is allowed to work on a payment row's money, and when they must let go.
 * A refund run holds its claim from before it reads the provider until after
 * it has written down what happened, which is what stops two runs sending the
 * same money back twice.
 *
 * This module is pure: it decides from the claim and the time it is shown.
 */

import type { RefundClaim } from "#shared/payment/row-state.ts";

/** A run asking to work on one reference group. Only the same sorted set of
 *  initiating attendees may resume its crashed command. */
export type ClaimRequest = {
  attendeeIds: readonly number[];
  scope: "attendee_set";
};

/** The exact command and lease guarding a refund run's physical rows. */
export interface HeldRefundCommand {
  readonly commandId: string;
  readonly held: ReadonlyMap<number, readonly string[]>;
  readonly heldSince: string;
}

/** A command boundary observed that its exact hold no longer exists. */
export type RefundClaimChanged = { readonly kind: "claim_changed" };

/** A decision attached to exact provider-aware payment-reference indexes. */
export interface IndexedRefundClaimDecision<TKind extends string> {
  readonly indexes: readonly string[];
  readonly kind: TKind;
}

export type HeldPaymentRow = {
  readonly attendeeId: number;
  readonly sessionId: string;
};

/** Name every exact payment row in an attendee-keyed claim. */
export const heldPaymentRows = (
  held: ReadonlyMap<number, readonly string[]>,
): HeldPaymentRow[] =>
  [...held].flatMap(([attendeeId, sessionIds]) =>
    sessionIds.map((sessionId) => ({ attendeeId, sessionId })),
  );

/** What a run may do with the row it just read. `grant` and `resume` both end
 *  holding the claim, kept apart because resuming means a previous run died
 *  mid-flight and must be re-judged behind fresh evidence. `held` and
 *  `foreign` both mean send nothing, kept apart by whose work it is.
 *
 *  A resume carries the claim it is taking over, so the run inheriting the
 *  work cannot lose what the dead run's call was made under. */
export type ClaimDecision =
  | { kind: "foreign" }
  | { kind: "grant" }
  | { kind: "held" }
  | { kind: "resume"; resuming: RefundClaim };

/** Whether this run ends up holding the row. Listed exhaustively so a new
 *  decision has to say which side it falls on. */
const CLAIMS_THE_ROW = {
  foreign: false,
  grant: true,
  held: false,
  resume: true,
} as const satisfies Record<ClaimDecision["kind"], boolean>;

/** Whether the run may go on to touch this row's money. */
export const holdsTheRow = (decision: ClaimDecision): boolean =>
  CLAIMS_THE_ROW[decision.kind];

/**
 * The shortest a claim may be treated as live for, however the reservation
 * sweep is tuned.
 *
 * Comfortably longer than any edge request can run. `STALE_RESERVATION_MS` is
 * an operator-tunable knob, and turning it down is harmless for its own job —
 * abandoned reservations are simply swept sooner. Reading a claim's lease off
 * the same number is not: below one request's lifetime a second run would
 * treat a worker that is still going as dead, resume its rows, and send a
 * keyless provider a second payout against the same charge.
 */
const MIN_CLAIM_LEASE_MS = 5 * 60 * 1000;

/** How long a claim counts as a live run's before it may be resumed. Takes the
 *  reservation cutoff so the two agree wherever the operator has raised it, and
 *  never drops below what a request can outlive. */
export const claimLeaseMs = (reservationStaleMs: number): number =>
  Math.max(reservationStaleMs, MIN_CLAIM_LEASE_MS);

/** A claim older than one request can live is a crashed worker, not a run
 *  still going. `staleBefore` is the cutoff {@link claimLeaseMs} decides. */
export const isClaimStale = (
  claim: RefundClaim,
  staleBefore: string,
): boolean => claim.writtenAt < staleBefore;

const sameAttendees = (claim: RefundClaim, request: ClaimRequest): boolean =>
  claim.attendeeIds.length === request.attendeeIds.length &&
  claim.attendeeIds.every((id, index) => id === request.attendeeIds[index]);

/** Decide what this run may do with a row. A stale claim is resumable only by
 *  a run taking the same attendee again — recovering somebody else's work
 *  would send a refund from under them. */
export const decideClaim = (
  existing: RefundClaim | undefined,
  request: ClaimRequest,
  staleBefore: string,
): ClaimDecision => {
  if (existing === undefined) return { kind: "grant" };
  if (!isClaimStale(existing, staleBefore)) return { kind: "held" };
  return sameAttendees(existing, request)
    ? { kind: "resume", resuming: existing }
    : { kind: "foreign" };
};

/** Why no money was sent, in words for a log line. The two claiming answers
 *  have no reason to give, and say so rather than falling into a default. */
const REFUSAL_REASONS = {
  foreign: "another kind of run holds this payment",
  grant: null,
  held: "a refund for this payment is already in progress",
  resume: null,
} as const satisfies Record<ClaimDecision["kind"], string | null>;

/** Say why a run was turned away. Asking this of a claim that was granted is a
 *  bug, so it fails rather than inventing words. */
export const claimRefusal = (decision: ClaimDecision): string => {
  const reason = REFUSAL_REASONS[decision.kind];
  if (reason === null) {
    throw new Error(`A granted claim has no refusal: ${decision.kind}`);
  }
  return reason;
};
