/**
 * Who is allowed to work on a payment row's money, and when they must let go.
 *
 * A refund run holds a claim from before it reads the provider until after it
 * has written down what happened. That span is what stops two runs sending the
 * same money back twice, so the rules for taking and releasing a claim live
 * here on their own, away from the database work that applies them.
 *
 * This module is pure: it decides from the claim it is shown and the time it is
 * given.
 */

import type {
  RefundCapability,
  RefundClaim,
} from "#shared/payment/row-state.ts";

/** A run asking to work on a row. An admin run names the attendee whose whole
 *  reference set it is taking, because only a run taking that same set again
 *  may pick up where a crashed one left off. */
export type ClaimRequest =
  | { attendeeId: number; scope: "attendee_set" }
  | { scope: "callback" };

/**
 * What a run may do with the row it just read.
 *
 * `grant` and `resume` both end with this run holding the claim; they are
 * separate answers because resuming means a previous run died mid-flight, which
 * the run must re-judge behind fresh evidence rather than trusting anything the
 * dead one left. `held` and `foreign` both mean "send nothing" — the difference
 * is whether the work belongs to someone in this run's own scope or to a scope
 * this run must never touch.
 */
export type ClaimDecision =
  | { kind: "foreign" }
  | { kind: "grant" }
  | { kind: "held" }
  | { kind: "resume" };

/** Whether this run ends up holding the row. Listing both claiming answers
 *  means a new decision has to say which side it falls on. */
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
 * A claim older than one request can possibly live is a crashed worker, not a
 * run still going, so it stops holding the row. `staleBefore` is the same
 * written-at cutoff the reservation sweep compares against, so both read
 * staleness off one clock.
 */
export const isClaimStale = (
  claim: RefundClaim,
  staleBefore: string,
): boolean => claim.writtenAt < staleBefore;

const sameAttendee = (claim: RefundClaim, request: ClaimRequest): boolean =>
  claim.scope === "attendee_set" &&
  request.scope === "attendee_set" &&
  claim.attendeeId === request.attendeeId;

/**
 * Decide what this run may do with a row.
 *
 * A claim in another scope is left alone whether it is fresh or stale: a
 * callback and an admin run recover differently, and each recovering the
 * other's work is how a refund gets sent from under someone.
 */
export const decideClaim = (
  existing: RefundClaim | undefined,
  request: ClaimRequest,
  staleBefore: string,
): ClaimDecision => {
  if (existing === undefined) return { kind: "grant" };
  if (existing.scope !== request.scope) return { kind: "foreign" };
  if (!isClaimStale(existing, staleBefore)) return { kind: "held" };
  return existing.scope === "callback" || sameAttendee(existing, request)
    ? { kind: "resume" }
    : { kind: "foreign" };
};

/** Why no money was sent, in words for a log line. The two claiming answers
 *  have no reason to give, and listing them as such keeps a new decision from
 *  quietly falling into whichever arm happens to be last. */
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

/**
 * How a refund call under this claim ended, as far as releasing goes.
 *
 * `not_sent` covers every ending where no money was asked for at all — the
 * judgment parked, or discovery never found a provider — so there is nothing
 * to be in doubt about.
 */
export type ClaimAnswer = "lost" | "not_sent" | "validated";

/**
 * Whether the claim may be let go now.
 *
 * A lost answer is the one that turns on the provider: with an idempotency key
 * a re-run lands on the same refund, so the claim can go. Without one — SumUp,
 * or a reference whose provider is still unknown — letting go would let the
 * next run send a second payout against evidence that has not caught up, so the
 * claim stands until fresh evidence says what the money did.
 */
export const mayReleaseClaim = (
  capability: RefundCapability,
  answer: ClaimAnswer,
): boolean => answer !== "lost" || capability === "keyed";
