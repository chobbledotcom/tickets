import * as v from "valibot";
import {
  MoneySchema,
  ProviderChargeResourceSchema,
  ProviderSessionResourceSchema,
} from "#shared/payment-state/resources.ts";

export const LegacyProviderAssignmentReadSchema = v.variant("status", [
  v.strictObject({
    captured: MoneySchema,
    charge: ProviderChargeResourceSchema,
    refunded: MoneySchema,
    session: ProviderSessionResourceSchema,
    status: v.literal("attached"),
  }),
  v.strictObject({
    captured: v.optional(MoneySchema),
    refunded: v.optional(MoneySchema),
    status: v.literal("ambiguous"),
  }),
  v.strictObject({ status: v.literal("missing") }),
  v.strictObject({
    captured: MoneySchema,
    refunded: MoneySchema,
    status: v.literal("reviewed"),
  }),
]);
export type LegacyProviderAssignmentRead = v.InferOutput<
  typeof LegacyProviderAssignmentReadSchema
>;
