import * as v from "valibot";
import {
  PaymentModeSchema,
  PaymentObservationSchema,
  ProviderInvalidReasonSchema,
  ProviderUnavailableReasonSchema,
} from "#shared/payment-state/observation.ts";
import { LegacyProviderAssignmentReadSchema } from "#shared/payment-state/operator.ts";
import {
  MoneySchema,
  ProviderChargeResourceSchema,
  ProviderResourceSchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const kindObject = <const Kind extends string>(kind: Kind) =>
  v.strictObject({ kind: v.literal(kind) });

export const PaymentConflictSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("invalid_provider_data"),
    reason: ProviderInvalidReasonSchema,
  }),
  kindObject("missing_resource"),
  kindObject("resource_mismatch"),
  kindObject("currency_mismatch"),
  kindObject("provider_total_mismatch"),
  kindObject("partial_charge"),
  kindObject("capture_total_mismatch"),
  kindObject("refund_exceeds_capture"),
  kindObject("duplicate_charge"),
  kindObject("multiple_charges"),
  kindObject("duplicate_refund"),
  kindObject("multiple_pending_refunds"),
  kindObject("paid_without_charge"),
  kindObject("partial_refund"),
  kindObject("failed_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;

export const PaymentPendingReasonSchema = v.picklist([
  "payment_pending",
  "refund_pending",
]);
export type PaymentPendingReason = v.InferOutput<
  typeof PaymentPendingReasonSchema
>;

export const PaymentIgnoreReasonSchema = v.picklist([
  "not_ours",
  "payment_failed",
  "unproven_invalid_data",
  "unproven_missing_resource",
]);
export type PaymentIgnoreReason = v.InferOutput<
  typeof PaymentIgnoreReasonSchema
>;

export const PaymentResolutionSchema = v.variant("status", [
  v.strictObject({
    observation: PaymentObservationSchema,
    status: v.literal("ready"),
  }),
  v.strictObject({
    observation: PaymentObservationSchema,
    reason: PaymentPendingReasonSchema,
    status: v.literal("pending"),
  }),
  v.strictObject({
    observation: PaymentObservationSchema,
    status: v.literal("fully_refunded"),
  }),
  v.strictObject({
    reason: ProviderUnavailableReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("retry"),
  }),
  v.strictObject({
    issue: PaymentConflictSchema,
    observation: v.optional(PaymentObservationSchema),
    resource: ProviderResourceSchema,
    status: v.literal("conflict"),
  }),
  v.strictObject({
    reason: PaymentIgnoreReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("ignore"),
  }),
]);
export type PaymentResolution = v.InferOutput<typeof PaymentResolutionSchema>;

export const PaymentSessionStateSchema = v.picklist([
  "created",
  "pending",
  "ready",
  "processing",
  "completed",
  "failed",
  "refunding",
  "fully_refunded",
  "needs_action",
]);
export type PaymentSessionState = v.InferOutput<
  typeof PaymentSessionStateSchema
>;

export const PaymentCaseStateSchema = v.picklist([
  "retrying",
  "needs_action",
  "resolved",
]);
export type PaymentCaseState = v.InferOutput<typeof PaymentCaseStateSchema>;

export const PaymentRefundStateSchema = v.picklist([
  "none",
  "requested",
  "pending",
  "partial",
  "completed",
  "failed",
]);
export type PaymentRefundState = v.InferOutput<typeof PaymentRefundStateSchema>;

const decisionBase = {
  actorId: integerAtLeast(1),
  caseRevision: integerAtLeast(1),
  decidedAt: integerAtLeast(0),
  reason: ResourceIdSchema,
};

const paymentAccountFields = {
  accountId: ResourceIdSchema,
  mode: PaymentModeSchema,
  provider: PaymentProviderSchema,
};

const reviewedMoneyFields = {
  captured: MoneySchema,
  chargeId: integerAtLeast(1),
};

export const PaymentOperatorSelectionSchema = v.variant("kind", [
  kindObject("complete_booking"),
  kindObject("refund_remaining"),
  kindObject("confirm_fully_refunded"),
  kindObject("keep_legacy_payment"),
  v.strictObject({
    ...paymentAccountFields,
    kind: v.literal("assign_provider"),
  }),
]);
export type PaymentOperatorSelection = v.InferOutput<
  typeof PaymentOperatorSelectionSchema
>;

const reviewedChargeSchema = v.strictObject({
  ...reviewedMoneyFields,
  providerReference: ProviderChargeResourceSchema,
  refunded: MoneySchema,
});

const reviewedLegacyChargeSchema = v.strictObject({
  chargeId: integerAtLeast(1),
  providerReference: NonEmptyTextSchema,
});

export const PaymentChargeDecisionSnapshotSchema = v.strictObject({
  accountId: ResourceIdSchema,
  charges: v.pipe(v.array(reviewedChargeSchema), v.minLength(1)),
  kind: v.literal("charges"),
  mode: PaymentModeSchema,
  paymentId: ResourceIdSchema,
  provider: PaymentProviderSchema,
});
export type PaymentChargeDecisionSnapshot = v.InferOutput<
  typeof PaymentChargeDecisionSnapshotSchema
>;

export const PaymentLegacyDecisionSnapshotSchema = v.strictObject({
  charges: v.pipe(v.array(reviewedLegacyChargeSchema), v.minLength(1)),
  kind: v.literal("legacy_assignment"),
  paymentId: ResourceIdSchema,
});
export type PaymentLegacyDecisionSnapshot = v.InferOutput<
  typeof PaymentLegacyDecisionSnapshotSchema
>;

export const PaymentDecisionSnapshotSchema = v.variant("kind", [
  PaymentChargeDecisionSnapshotSchema,
  PaymentLegacyDecisionSnapshotSchema,
]);
export type PaymentDecisionSnapshot = v.InferOutput<
  typeof PaymentDecisionSnapshotSchema
>;

export const PaymentOperatorDecisionClaimSchema = v.strictObject({
  actorId: decisionBase.actorId,
  caseRevision: decisionBase.caseRevision,
  claimedAt: decisionBase.decidedAt,
  reason: decisionBase.reason,
  reviewed: PaymentDecisionSnapshotSchema,
  selection: PaymentOperatorSelectionSchema,
});
export type PaymentOperatorDecisionClaim = v.InferOutput<
  typeof PaymentOperatorDecisionClaimSchema
>;

export const PaymentOperatorDecisionSchema = v.variant("kind", [
  v.strictObject({ ...decisionBase, kind: v.literal("complete_booking") }),
  v.strictObject({ ...decisionBase, kind: v.literal("refund_remaining") }),
  v.strictObject({
    ...decisionBase,
    charges: v.pipe(
      v.array(
        v.strictObject({
          ...reviewedMoneyFields,
        }),
      ),
      v.minLength(1),
    ),
    kind: v.literal("confirm_fully_refunded"),
  }),
  v.strictObject({ ...decisionBase, kind: v.literal("keep_legacy_payment") }),
  v.strictObject({
    ...decisionBase,
    ...paymentAccountFields,
    kind: v.literal("assign_provider"),
    read: v.nullable(LegacyProviderAssignmentReadSchema),
  }),
]);
export type PaymentOperatorDecision = v.InferOutput<
  typeof PaymentOperatorDecisionSchema
>;

export const PaymentDecisionStateSchema = v.picklist([
  "accepted",
  "running",
  "retrying",
  "completed",
]);
export type PaymentDecisionState = v.InferOutput<
  typeof PaymentDecisionStateSchema
>;

/** Every reason a payment case can carry. A case is opened either because the
 * provider's answer did not add up (a conflict), because the provider could not
 * be reached, or because a payment copied from an older version is missing
 * something only the owner can supply. Naming them in one place is what lets
 * the pages that show them prove they have words for every one. */
export const PaymentCaseReasonSchema = v.picklist([
  ...PaymentConflictSchema.options.map((option) => option.entries.kind.literal),
  ...ProviderUnavailableReasonSchema.options,
  "legacy_lifecycle_unknown",
  "legacy_mapping_ambiguous",
  "legacy_provider_unknown",
  "legacy_refund_amount_unknown",
]);
export type PaymentCaseReason = v.InferOutput<typeof PaymentCaseReasonSchema>;
export const PAYMENT_CASE_REASONS = PaymentCaseReasonSchema.options;
