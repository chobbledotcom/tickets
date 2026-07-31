import * as v from "valibot";
import type { PaymentProviderType } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

export const ResourceIdSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.regex(/\S/u, "Resource id must contain text"),
);
export type ResourceId = v.InferOutput<typeof ResourceIdSchema>;

export const CurrencySchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z]{3}$/u, "Currency must be three uppercase letters"),
);
export type Currency = v.InferOutput<typeof CurrencySchema>;

export const MoneySchema = v.strictObject({
  amount: integerAtLeast(0),
  currency: CurrencySchema,
});
export type Money = v.InferOutput<typeof MoneySchema>;

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

export const ProviderChargeResourceSchema = v.union([
  providerResource("stripe", "stripe_payment_intent", {
    parentId: ResourceIdSchema,
  }),
  providerResource("square", "square_payment", {
    parentId: ResourceIdSchema,
  }),
  providerResource("sumup", "sumup_transaction", {
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

const refundResult = <
  const TStatus extends string,
  const TRefund extends v.GenericSchema,
  const TFields extends v.ObjectEntries,
>(
  status: TStatus,
  refund: TRefund,
  fields: TFields,
) =>
  v.strictObject({
    ...fields,
    amount: MoneySchema,
    refund,
    status: v.literal(status),
  });

const optionalRefund = v.optional(ProviderRefundResourceSchema);
const completedRefundResult = refundResult("completed", optionalRefund, {});
const pendingRefundResult = refundResult("pending", optionalRefund, {});

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
  refundResult("partial", optionalRefund, {}),
  refundResult("failed", optionalRefund, {
    reason: RefundFailureReasonSchema,
  }),
]);
export type RefundResolution = v.InferOutput<typeof RefundResolutionSchema>;

const PositiveMoneySchema = v.pipe(
  MoneySchema,
  v.check((money) => money.amount > 0, "A paid charge must be positive"),
);

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
      refund.refund === undefined ? [] : [refund.refund],
    ),
  );

export const refundMoneyMatchesCapture = (charge: ChargeLeg): boolean =>
  charge.confirmedRefunded.currency === charge.captured.currency &&
  charge.confirmedRefunded.amount <= charge.captured.amount &&
  charge.refunds.every(
    (refund) =>
      refund.amount.currency === charge.captured.currency &&
      refund.amount.amount <= charge.captured.amount,
  );
