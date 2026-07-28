import * as v from "valibot";
import {
  MoneySchema,
  ProviderChargeResourceSchema,
  ProviderSessionResourceSchema,
} from "#shared/payment-state/resources.ts";

/** A reading that says which money an old payment turned out to be. Each part
 *  is checked against the others, because this reading is what an owner's
 *  choice to give an old payment a provider is written down from — and that
 *  choice moves real money. */
const attachedReadSchema = v.pipe(
  v.strictObject({
    captured: MoneySchema,
    charge: ProviderChargeResourceSchema,
    refunded: MoneySchema,
    session: ProviderSessionResourceSchema,
    status: v.literal("attached"),
  }),
  v.check(
    (read) => read.charge.provider === read.session.provider,
    "Charge must come from the same provider as the checkout",
  ),
  v.check(
    (read) => read.charge.parentId === read.session.id,
    "Charge must belong to the checkout it is attached to",
  ),
  v.check(
    (read) => read.refunded.currency === read.captured.currency,
    "Money returned must be in the same currency as the money taken",
  ),
  v.check(
    (read) => read.refunded.amount <= read.captured.amount,
    "Money returned cannot be more than the money taken",
  ),
);

export const LegacyProviderAssignmentReadSchema = v.variant("status", [
  attachedReadSchema,
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
