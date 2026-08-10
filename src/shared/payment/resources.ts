import * as v from "valibot";
import { sumOf } from "#fp";
import { MoneySchema } from "#shared/payment/money.ts";
import { ResourceIdSchema } from "#shared/payment/resource-id.ts";
import { RESOURCE_KIND_BY_PROVIDER } from "#shared/payment/words.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const providerResource = <
  const TProvider extends PaymentProviderType,
  const TKind extends string,
  const TFields extends v.ObjectEntries,
>(
  provider: TProvider,
  kind: TKind,
  fields: TFields,
) =>
  v.strictObject({
    ...fields,
    id: ResourceIdSchema,
    kind: v.literal(kind),
    provider: v.literal(provider),
  });

export const ProviderSessionResourceSchema = v.union([
  providerResource("stripe", "stripe_checkout_session", {}),
  providerResource("square", "square_order", {}),
  providerResource("sumup", "sumup_checkout", {}),
]);
export type ProviderSessionResource = v.InferOutput<
  typeof ProviderSessionResourceSchema
>;

// The kind names come from the vocabulary rather than being written again
// here, so a provider cannot end up with two names for the money it took.
export const ProviderChargeResourceSchema = v.union([
  providerResource("stripe", RESOURCE_KIND_BY_PROVIDER.stripe, {
    parentId: ResourceIdSchema,
  }),
  providerResource("square", RESOURCE_KIND_BY_PROVIDER.square, {
    parentId: ResourceIdSchema,
  }),
  providerResource("sumup", RESOURCE_KIND_BY_PROVIDER.sumup, {
    parentId: ResourceIdSchema,
  }),
]);
export type ProviderChargeResource = v.InferOutput<
  typeof ProviderChargeResourceSchema
>;

export const ProviderRefundResourceSchema = v.union([
  providerResource("stripe", "stripe_refund", {
    parentId: ResourceIdSchema,
  }),
  providerResource("square", "square_refund", {
    parentId: ResourceIdSchema,
  }),
  providerResource("sumup", "sumup_refund", {
    parentId: ResourceIdSchema,
  }),
]);
export type ProviderRefundResource = v.InferOutput<
  typeof ProviderRefundResourceSchema
>;

export const ProviderResourceSchema = v.union([
  ProviderSessionResourceSchema,
  ProviderChargeResourceSchema,
  ProviderRefundResourceSchema,
]);
export type ProviderResource = v.InferOutput<typeof ProviderResourceSchema>;

export const sameProviderResource = (
  left: ProviderResource,
  right: ProviderResource,
): boolean =>
  left.provider === right.provider &&
  left.kind === right.kind &&
  left.id === right.id;

/** Money that has to be some actual money. Nothing was never taken, and
 *  nothing is never on its way back. */
const positiveMoney = (message: string) =>
  v.pipe(
    MoneySchema,
    v.check((money) => money.amount > 0, message),
  );

export const PositiveMoneySchema = positiveMoney(
  "A paid charge must be positive",
);

/** A refund that says money moved has to have moved some. A refund of nothing
 *  is answered before the money already returned is looked at, so a charge
 *  fully given back would read as still going, for ever, and the provider
 *  saying a refund finished would be thrown away. The one refund that may be
 *  for nothing is a failed one, where no money moved at all. */
const MovedRefundMoneySchema = positiveMoney(
  "A refund that moved money must be positive",
);

const refundResult = <
  const TStatus extends string,
  const TRefund extends v.GenericSchema,
  const TFields extends v.ObjectEntries,
>(
  status: TStatus,
  refund: TRefund,
  // An amount given here replaces the default, for the states that demand more
  // of it than simply not being negative.
  fields: TFields,
) =>
  v.strictObject({
    amount: MoneySchema,
    ...fields,
    refund,
    status: v.literal(status),
  });

const optionalRefund = v.optional(ProviderRefundResourceSchema);
const completedRefundResult = refundResult("completed", optionalRefund, {
  amount: MovedRefundMoneySchema,
});
const pendingRefundResult = refundResult("pending", optionalRefund, {
  amount: MovedRefundMoneySchema,
});

export const RefundObservationSchema = v.variant("status", [
  completedRefundResult,
  pendingRefundResult,
  refundResult("failed", optionalRefund, { reason: ResourceIdSchema }),
]);
export type RefundObservation = v.InferOutput<typeof RefundObservationSchema>;

export const RefundFailureReasonSchema = v.picklist([
  "provider_failed",
  "invalid_amount",
  "multiple_pending_refunds",
  "not_observed",
]);
export type RefundFailureReason = v.InferOutput<
  typeof RefundFailureReasonSchema
>;

export const RefundResolutionSchema = v.variant("status", [
  completedRefundResult,
  pendingRefundResult,
  refundResult("partial", optionalRefund, { amount: MovedRefundMoneySchema }),
  refundResult("failed", optionalRefund, {
    reason: RefundFailureReasonSchema,
  }),
]);
export type RefundResolution = v.InferOutput<typeof RefundResolutionSchema>;

export const ChargeLegSchema = v.strictObject({
  captured: PositiveMoneySchema,
  confirmedRefunded: MoneySchema,
  refunds: v.array(RefundObservationSchema),
  resource: ProviderChargeResourceSchema,
});
export type ChargeLeg = v.InferOutput<typeof ChargeLegSchema>;

export const ChargeLegsSchema = v.pipe(
  v.array(ChargeLegSchema),
  v.minLength(1),
);
export type ChargeLegs = v.InferOutput<typeof ChargeLegsSchema>;

export const providerRefundResources = (
  charges: readonly ChargeLeg[],
): ProviderRefundResource[] =>
  charges.flatMap((charge) =>
    charge.refunds.flatMap((refund) =>
      refund.refund === undefined ? [] : [refund.refund]
    )
  );

/** Money on its way back that the provider has not finished sending. A refund
 *  it has finished is already counted in the returned total, so only the ones
 *  still going are added on top. */
/** The money named by every refund at one point in its life, added up. */
const refundMoneyThatIs =
  (status: RefundObservation["status"]) => (charge: ChargeLeg): number =>
    sumOf((refund: RefundObservation) => refund.amount.amount)(
      charge.refunds.filter((refund) => refund.status === status),
    );

const refundMoneyStillGoing = refundMoneyThatIs("pending");
const refundMoneyGivenBack = refundMoneyThatIs("completed");

/**
 * Compares money given back with money taken. Two currencies cannot be
 * compared at all, so that is checked here once; which refunds count, and how
 * the two totals must compare, is the caller's to say.
 */
const comparedWithMoneyTaken = (
  moneyBack: (charge: ChargeLeg) => number,
  holds: (back: number, taken: number) => boolean,
) =>
(charge: ChargeLeg): boolean =>
  charge.confirmedRefunded.currency === charge.captured.currency &&
  holds(moneyBack(charge), charge.captured.amount);

/**
 * Everything that has gone back or is going back, counted once. The returned
 * total is meant to already hold the refunds the provider says it finished,
 * so adding both would count those twice — but the total can also lag behind
 * a refund it has not caught up with. Taking whichever of the two is larger
 * covers both, and money still on its way is genuinely on top of it.
 */
const refundMoneyAccountedFor = (charge: ChargeLeg): number =>
  Math.max(charge.confirmedRefunded.amount, refundMoneyGivenBack(charge)) +
  refundMoneyStillGoing(charge);

/** Nothing given back, or still on its way, comes to more than was taken. */
const refundFitsWithinCapture = comparedWithMoneyTaken(
  refundMoneyAccountedFor,
  (back, taken) => back <= taken,
);

export const refundMoneyMatchesCapture = (charge: ChargeLeg): boolean =>
  refundFitsWithinCapture(charge) &&
  charge.refunds.every(
    (refund) =>
      refund.amount.currency === charge.captured.currency &&
      refund.amount.amount <= charge.captured.amount,
  );
