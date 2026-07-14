import * as v from "valibot";

export const CheckoutStageStateSchema = v.picklist([
  "pending",
  "refunding",
  "booked",
  "failed",
]);

export type CheckoutStageState = v.InferOutput<typeof CheckoutStageStateSchema>;

/** Whether a stage still owns its quantity-zero rows: either the checkout may
 * activate them, or a started refund must finish without letting them activate. */
export const isOpenCheckoutStage = (state: CheckoutStageState): boolean =>
  state === "pending" || state === "refunding";

/** SQL membership test matching {@link isOpenCheckoutStage}. */
export const OPEN_CHECKOUT_STAGE_SQL = "IN ('pending', 'refunding')";
