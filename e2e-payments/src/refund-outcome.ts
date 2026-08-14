/**
 * Classify what a submitted refund actually left behind.
 *
 * The classification is pure: steps gather the page facts and the provider
 * observation, and this module decides — loudly — which of the two valid live
 * outcomes they describe. Any other combination is a failure, never a
 * best-effort guess.
 */

import type { SandboxRefundObservation } from "./providers/types.ts";

/** What the owner-facing pages show after a refund submission. */
export interface RefundPageFacts {
  /** The attendee Actions tab still offers its Delete action. */
  deleteActionVisible: boolean;
  /** The Refresh payment status control is reachable. */
  refreshReachable: boolean;
  /** The attendee Actions tab still offers a Refund action. */
  refundActionVisible: boolean;
  /** The attendee/roster shows the "Refunded" badge or status. */
  refundedVisible: boolean;
  /** A pending/unrecorded-work warning is visible on the page. */
  unfinishedWorkWarningVisible: boolean;
}

/** The two outcomes a live sandbox refund may honestly reach. */
export type RefundOutcome =
  | { kind: "refund_recorded" }
  | { kind: "refund_observing" };

/** One expectation about the page; `claim` is its human wording. */
type Claim = { claim: string; ok: boolean };

const requireClaims = (claims: Claim[], context: string): void => {
  const failed = claims.filter((c) => !c.ok).map((c) => c.claim);
  if (failed.length > 0) throw new Error(`${context}: ${failed.join("; ")}`);
};

/** The claims the two outcome branches make about the same page facts — each
 * stated once, with the branch's own wording and its own pass rule. */
/** Both branches demand the Refund action be gone — it can never send again
 * after this scenario's one submission. */
const refundActionUnavailable = (page: RefundPageFacts): Claim => ({
  claim: "the Refund action is unavailable",
  ok: !page.refundActionVisible,
});

const completedClaims = (page: RefundPageFacts): Claim[] => [
  { claim: "the Refunded status is visible", ok: page.refundedVisible },
  refundActionUnavailable(page),
  {
    claim: "no unfinished-refund warning is shown",
    ok: !page.unfinishedWorkWarningVisible,
  },
  { claim: "the Delete action is available", ok: page.deleteActionVisible },
];

/** The safe protected state while refund work is unfinished: nothing claims
 * the refund completed, nothing can send or destroy, the owner is warned, and
 * Refresh stays reachable. */
const unfinishedWorkClaims = (page: RefundPageFacts): Claim[] => [
  { claim: "the Refunded status is not shown", ok: !page.refundedVisible },
  refundActionUnavailable(page),
  { claim: "the Delete action is unavailable", ok: !page.deleteActionVisible },
  {
    claim: "an unfinished-refund warning is shown",
    ok: page.unfinishedWorkWarningVisible,
  },
  { claim: "Refresh remains reachable", ok: page.refreshReachable },
];

/**
 * Classify the state after the one rendered Refund submission. A provider that
 * reports the full amount back must have recorded locally (and re-enabled the
 * destructive controls); a provider still settling must show the safe
 * observing state and nothing that could send again.
 */
export const classifySubmittedRefund = (
  page: RefundPageFacts,
  provider: SandboxRefundObservation,
): RefundOutcome => {
  if (provider.kind === "completed") {
    requireClaims(
      completedClaims(page),
      "the provider returned the full amount but the local result disagrees",
    );
    return { kind: "refund_recorded" };
  }
  requireClaims(
    unfinishedWorkClaims(page),
    "the refund may have landed but the page does not show the safe observing state",
  );
  return { kind: "refund_observing" };
};

/**
 * Classify the state after the provider returned money while the local Money
 * write failed: the same safe protected state as observing — a warning not to
 * refund again, no Refund and no Delete, and Refresh reachable.
 */
export const classifyReturnedLocalDue = (page: RefundPageFacts): void => {
  requireClaims(
    unfinishedWorkClaims(page),
    "money was returned but the page does not show the durable unrecorded state",
  );
};
