/**
 * Who is allowed to work on a payment row's money, and when they must let go.
 * A refund run holds its claim from before it reads the provider until after
 * it has written down what happened, which is what stops two runs sending the
 * same money back twice.
 *
 * This module is pure: it decides from the claim and the time it is shown.
 */

import type {
  RefundCapability,
  RefundClaim,
} from "#shared/payment/row-state.ts";

/** A run asking to work on a row. An admin run names its attendee, because
 *  only a run taking that same whole set again may resume a crashed one. */
export type ClaimRequest = { attendeeId: number; scope: "attendee_set" };

/** What a run may do with the row it just read. `grant` and `resume` both end
 *  holding the claim, kept apart because resuming means a previous run died
 *  mid-flight and must be re-judged behind fresh evidence. `held` and
 *  `foreign` both mean send nothing, kept apart by whose work it is. */
export type ClaimDecision =
  | { kind: "foreign" }
  | { kind: "grant" }
  | { kind: "held" }
  | { kind: "resume" };

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

/** A claim older than one request can live is a crashed worker, not a run
 *  still going. `staleBefore` is the reservation sweep's own cutoff, so both
 *  read staleness off one clock. */
export const isClaimStale = (
  claim: RefundClaim,
  staleBefore: string,
): boolean => claim.writtenAt < staleBefore;

const sameAttendee = (claim: RefundClaim, request: ClaimRequest): boolean =>
  claim.attendeeId === request.attendeeId;

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
  return sameAttendee(existing, request)
    ? { kind: "resume" }
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

/** How a refund call under this claim ended, as far as releasing goes.
 *  `not_sent` covers every ending where no money was asked for at all, so
 *  there is nothing to be in doubt about. */
export type ClaimAnswer = "lost" | "not_sent" | "validated";

/** Whether the claim may be let go now. A lost answer turns on the provider:
 *  with an idempotency key a re-run lands on the same refund, so the claim can
 *  go; without one, letting go lets the next run send a second payout against
 *  evidence that has not caught up. */
export const mayReleaseClaim = (
  capability: RefundCapability,
  answer: ClaimAnswer,
): boolean => answer !== "lost" || capability === "keyed";
