import * as v from "valibot";

/**
 * The refund state of a charge the live path tracks.
 *
 * "unknown" belongs only to a legacy charge — one copied from an older system
 * whose record never said whether its refund went through. A charge made on
 * this system is always a known "none" or "completed".
 */
export const RefundStateSchema = v.picklist(["none", "completed", "unknown"]);
export type RefundState = v.InferOutput<typeof RefundStateSchema>;

/**
 * The refund state for a charge, given whether the provider returned the money
 * and whether the charge is a legacy one.
 */
export const refundStateOf = ({
  refunded,
  legacy,
}: {
  refunded: boolean;
  legacy: boolean;
}): RefundState => (refunded ? "completed" : legacy ? "unknown" : "none");
