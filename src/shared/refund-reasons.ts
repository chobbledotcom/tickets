import * as v from "valibot";
import type { ErrorCodeType } from "#shared/logger.ts";

export const RefundCodeSchema = v.picklist([
  "capacity_full",
  "charge_mismatch",
  "listing_removed",
  "price_changed",
  "sold_out",
  "unexpected_error",
]);
export type RefundCode = v.InferOutput<typeof RefundCodeSchema>;

export const StoredCheckoutRefundSchema = v.object({
  code: RefundCodeSchema,
  detail: v.string(),
  error: v.optional(v.string()),
  reason: v.string(),
  status: v.optional(v.number()),
});
export type StoredCheckoutRefund = v.InferOutput<
  typeof StoredCheckoutRefundSchema
>;

export interface RefundSpec extends StoredCheckoutRefund {
  notify?: ErrorCodeType;
}

/** Notifications are sent on the first attempt. Store only the stable reason
 * and response fields needed to resume the same refund later. */
export const storedCheckoutRefund = ({
  notify: _notify,
  ...refund
}: RefundSpec): StoredCheckoutRefund => refund;
