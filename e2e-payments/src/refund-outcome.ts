/**
 * Classify what a submitted refund actually left behind.
 *
 * The classification is pure: steps gather the page facts and the provider
 * observation, and this module decides — loudly — which of the two valid live
 * outcomes they describe. Any other combination is a failure, never a
 * best-effort guess.
 */

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
 * Classify the state after the one rendered Refund submission. The LOCAL page
 * state is the source of truth — it reports what the app honestly recorded at
 * submission time. The provider's later observation only corroborates: a
 * provider that has since completed a refund the app recorded as observing
 * does not contradict the app (the observation just became eligible for a
 * Refresh), so the provider amount is checked separately by the caller.
 */
export const classifySubmittedRefund = (
  page: RefundPageFacts,
): RefundOutcome => {
  if (page.unfinishedWorkWarningVisible) {
    // The app honestly reported unfinished refund work at submission time.
    requireClaims(
      unfinishedWorkClaims(page),
      "the refund was accepted but the page does not show the safe observing state",
    );
    return { kind: "refund_observing" };
  }
  requireClaims(
    completedClaims(page),
    "the page does not show the refund as recorded",
  );
  return { kind: "refund_recorded" };
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
