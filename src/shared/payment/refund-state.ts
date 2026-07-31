/**
 * The refund state of a charge the live path tracks.
 *
 * "unknown" is the starting state of a legacy charge alone — one copied across
 * from an older system whose record never said whether its refund went through.
 * A charge made on this system is always a known "none" (not yet refunded) or
 * "completed" (the provider returned the money); it can never read as
 * "unknown", because this system watched the charge from the moment it was made.
 *
 * The provider's refund query answers a boolean (refunded or not). {@link refundStateOf}
 * is the one place that boolean is turned into a refund state, so "unknown" can
 * only appear for a legacy charge and a current charge can never be mislabelled
 * with it.
 */

export type RefundState = "none" | "completed" | "unknown";

/**
 * The refund state for a charge, given whether the provider returned the money
 * and whether the charge is a legacy one. A refunded charge is "completed"
 * either way; a not-refunded charge is "unknown" only when it is legacy (its
 * refund was never observed), and "none" when it is a current charge this system
 * has watched from the start.
 */
export const refundStateOf = ({
  refunded,
  legacy,
}: {
  refunded: boolean;
  legacy: boolean;
}): RefundState => (refunded ? "completed" : legacy ? "unknown" : "none");
