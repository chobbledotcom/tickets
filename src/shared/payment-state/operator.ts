import * as v from "valibot";
import type { Money } from "#shared/payment-state/resources.ts";
import {
  MoneySchema,
  PositiveMoneySchema,
  ProviderChargeResourceSchema,
  ProviderSessionResourceSchema,
} from "#shared/payment-state/resources.ts";

/** Money given back fits inside the money taken, and is the same kind of money.
 *  Shared because several written-down readings carry both figures. */
export const refundFitsInsideCapture = (money: {
  captured: Money;
  refunded: Money;
}): boolean =>
  money.refunded.currency === money.captured.currency &&
  money.refunded.amount <= money.captured.amount;

/** Adds the money rule to any reading that carries both figures. */
const withRefundRule = <
  TSchema extends v.GenericSchema<{ captured: Money; refunded: Money }>,
>(
  schema: TSchema,
) =>
  v.pipe(
    schema,
    v.check(
      (money) => refundFitsInsideCapture(money),
      "Money returned must fit inside the money taken, in the same currency",
    ),
  );

/** A reading that says which money an old payment turned out to be. Each part
 *  is checked against the others, because this reading is what an owner's
 *  choice to give an old payment a provider is written down from — and that
 *  choice moves real money. */
const attachedReadSchema = withRefundRule(
  v.pipe(
    v.strictObject({
      captured: PositiveMoneySchema,
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
  ),
);

export const LegacyProviderAssignmentReadSchema = v.variant("status", [
  attachedReadSchema,
  v.pipe(
    v.strictObject({
      captured: v.optional(MoneySchema),
      refunded: v.optional(MoneySchema),
      status: v.literal("ambiguous"),
    }),
    // An unclear reading may know neither figure, but when it knows both they
    // still have to add up: this is written into the owner's choice to give an
    // old payment a provider, and that choice moves real money.
    v.check(
      (read) =>
        read.captured === undefined ||
        read.refunded === undefined ||
        refundFitsInsideCapture({
          captured: read.captured,
          refunded: read.refunded,
        }),
      "Money returned must fit inside the money taken, in the same currency",
    ),
  ),
  v.strictObject({ status: v.literal("missing") }),
  withRefundRule(
    v.strictObject({
      captured: PositiveMoneySchema,
      refunded: MoneySchema,
      status: v.literal("reviewed"),
    }),
  ),
]);
export type LegacyProviderAssignmentRead = v.InferOutput<
  typeof LegacyProviderAssignmentReadSchema
>;
