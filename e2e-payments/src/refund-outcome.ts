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

/** What positively proves the refund was recorded: the Refunded status is
 * up, the send is gone, and no unfinished work remains. Delete's return is
 * deliberately NOT a claim here — a provider-side-completed refund whose
 * retirement (observation expiry, queue sweep) has not caught up yet still
 * blocks Delete for a while, and that is a safe recorded state, not a
 * disagreement. The Stripe recovery scenario proves Delete reachability
 * where retirement was actually completed. */
const completedClaims = (page: RefundPageFacts): Claim[] => [
  { claim: "the Refunded status is visible", ok: page.refundedVisible },
  refundActionUnavailable(page),
  {
    claim: "no unfinished-refund warning is shown",
    ok: !page.unfinishedWorkWarningVisible,
  },
];

/** The durable safety of the observing state: nothing claims the refund
 * completed, nothing can send or destroy, and Refresh stays reachable. The
 * one-shot flash warning is deliberately NOT required here — it lives on the
 * page the submission redirected to and can be gone by the time the facts
 * are gathered; the fault scenario asserts it via classifyReturnedLocalDue,
 * which reads the landing page directly. */
const observingClaims = (page: RefundPageFacts): Claim[] => [
  { claim: "the Refunded status is not shown", ok: !page.refundedVisible },
  refundActionUnavailable(page),
  { claim: "the Delete action is unavailable", ok: !page.deleteActionVisible },
  { claim: "Refresh remains reachable", ok: page.refreshReachable },
];

/**
 * Classify the state after the one rendered Refund submission. The page
 * positively proves "recorded" only when it shows the Refunded status —
 * anything less is the honest observing state (a settling provider leaves
 * exactly that: not refunded yet, sends blocked), whose own safety claims
 * must then hold.
 */
export const classifySubmittedRefund = (
  page: RefundPageFacts,
): RefundOutcome => {
  if (page.refundedVisible) {
    requireClaims(
      completedClaims(page),
      "the attendee says Refunded but the rest of the page disagrees",
    );
    return { kind: "refund_recorded" };
  }
  requireClaims(
    observingClaims(page),
    "the refund is not shown as recorded, so the page must show the safe observing state",
  );
  return { kind: "refund_observing" };
};

/** The claims of the returned-but-unrecorded fault state: the durable
 * observing protections PLUS the explicit warning that money already went
 * back and must not be sent again — this state is reached straight from the
 * submission's redirect, so the warning is still on the page. */
const returnedLocalDueClaims = (page: RefundPageFacts): Claim[] => [
  ...observingClaims(page),
  {
    claim: "an unfinished-refund warning is shown",
    ok: page.unfinishedWorkWarningVisible,
  },
];

/**
 * Classify the state after the provider returned money while the local Money
 * write failed: the safe protected state plus the warning not to refund
 * again.
 */
export const classifyReturnedLocalDue = (page: RefundPageFacts): void => {
  requireClaims(
    returnedLocalDueClaims(page),
    "money was returned but the page does not show the durable unrecorded state",
  );
};
