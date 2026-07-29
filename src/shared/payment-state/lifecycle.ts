import * as v from "valibot";
import { unique } from "#fp";
import {
  PaymentModeSchema,
  PaymentObservationSchema,
  ProviderInvalidReasonSchema,
  ProviderUnavailableReasonSchema,
} from "#shared/payment-state/observation.ts";
import {
  LegacyProviderAssignmentReadSchema,
  refundFitsInsideCapture,
} from "#shared/payment-state/operator.ts";
import type { ChargeLeg } from "#shared/payment-state/resources.ts";
import {
  gaveEverythingBack,
  MoneySchema,
  PositiveMoneySchema,
  ProviderChargeResourceSchema,
  ProviderResourceSchema,
  ResourceIdSchema,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import {
  CASE_STATES,
  DECISION_STATES,
  PAYMENT_STATES,
  REFUND_STATES,
} from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

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

type Observation = v.InferOutput<typeof PaymentObservationSchema>;

/**
 * An answer that carries the reading it was worked out from, and only holds
 * when that reading still says so. Written once because the two answers using
 * it are the ones nothing may fake: a payment ready to book, and money finally
 * given back.
 */
const answerFromReading = <const Status extends string>(
  status: Status,
  readingSaysSo: (observation: Observation) => boolean,
  message: string,
) =>
  v.pipe(
    v.strictObject({
      observation: PaymentObservationSchema,
      status: v.literal(status),
    }),
    v.check((answer) => readingSaysSo(answer.observation), message),
  );

/** Fully refunded means every charge has given back everything. Without this,
 *  money still held on one charge could be filed as finally returned. A
 *  reading with no charge at all took nothing to give back. */
const everythingCameBack = (observation: Observation): boolean =>
  observation.status === "paid" &&
  observation.charges !== undefined &&
  observation.charges.every(gaveEverythingBack);

/** A charge the provider has not finished giving money back on. */
const chargeIsStillRefunding = (charge: ChargeLeg): boolean =>
  charge.refunds.some((refund) => refund.status === "pending");

/** Money on its way back somewhere in this reading. A reading with no charge
 *  took nothing, so nothing can be coming back from it. */
const aRefundIsStillGoing = (observation: Observation): boolean =>
  observation.charges?.some(chargeIsStillRefunding) ?? false;

/** A charge that has kept every penny it took. */
const nothingGivenBack = (charge: ChargeLeg): boolean =>
  charge.confirmedRefunded.amount === 0;

/** The buyer paid and the money has stayed paid: none given back, none on its
 *  way back. Money part-returned is a problem for the owner, money fully
 *  returned is its own answer, and money still going is waited on — so a
 *  reading in any of those states is not a booking waiting to be made. */
const paidAndStayedPaid = (observation: Observation): boolean =>
  observation.status === "paid" &&
  (observation.charges ?? []).every(nothingGivenBack) &&
  !aRefundIsStillGoing(observation);

/** Ready means the money question is settled: the buyer paid and the money
 *  stayed paid, or nothing was owed and so nothing was taken. A reading still
 *  going, or one that failed, would otherwise let an unpaid checkout be
 *  treated as ready to book. */
const moneyQuestionSettled = (observation: Observation): boolean =>
  paidAndStayedPaid(observation) ||
  (observation.status === "no_payment_required" &&
    observation.expected.amount === 0 &&
    observation.charges === undefined);

export const PaymentResolutionSchema = v.variant("status", [
  answerFromReading(
    "ready",
    moneyQuestionSettled,
    "A payment is only ready when it was paid, or nothing was owed",
  ),
  v.pipe(
    v.strictObject({
      observation: PaymentObservationSchema,
      reason: PaymentPendingReasonSchema,
      status: v.literal("pending"),
    }),
    // Waiting on the payment means the reading is still going; waiting on a
    // refund means the money was taken and a refund really is on its way back.
    // Checked apart, a settled reading with nothing in flight could be left on
    // the retry path forever, looked at again and again with nothing to find.
    v.check(
      (answer) =>
        answer.reason === "payment_pending"
          ? answer.observation.status === "pending"
          : answer.observation.status === "paid" &&
            aRefundIsStillGoing(answer.observation),
      "What a payment is waiting for must match what its reading says",
    ),
  ),
  answerFromReading(
    "fully_refunded",
    everythingCameBack,
    "A payment is only fully refunded once a charge has given it all back",
  ),
  v.strictObject({
    reason: ProviderUnavailableReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("retry"),
  }),
  v.pipe(
    v.strictObject({
      issue: PaymentConflictSchema,
      observation: v.optional(PaymentObservationSchema),
      resource: ProviderResourceSchema,
      status: v.literal("conflict"),
    }),
    v.check(
      (resolution) =>
        resolution.observation === undefined ||
        sameProviderResource(
          resolution.resource,
          resolution.observation.session,
        ),
      "A problem must name the same checkout its evidence describes",
    ),
  ),
  v.strictObject({
    reason: PaymentIgnoreReasonSchema,
    resource: ProviderResourceSchema,
    status: v.literal("ignore"),
  }),
]);
export type PaymentResolution = v.InferOutput<typeof PaymentResolutionSchema>;

export const PaymentSessionStateSchema = v.picklist(PAYMENT_STATES);
export type PaymentSessionState = v.InferOutput<
  typeof PaymentSessionStateSchema
>;

export const PaymentCaseStateSchema = v.picklist(CASE_STATES);
export type PaymentCaseState = v.InferOutput<typeof PaymentCaseStateSchema>;

/** Where a refund has got to. "unknown" belongs only to money copied from an
 *  older version, whose record never said what became of its refund. */
export const PaymentRefundStateSchema = v.picklist(REFUND_STATES);
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
  captured: PositiveMoneySchema,
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

/** Nothing in the list turns up more than once. */
const listsEachOnce = (values: (string | number)[]): boolean =>
  unique(values).length === values.length;

/** The same money listed twice would be offered to the worker twice, and a
 *  reading that showed it that way is treated as a problem elsewhere. A charge
 *  is the same money if either its own id or the provider's name for it
 *  repeats — how that name is read differs between a current and an old
 *  payment, so it is given here. */
const withNoRepeatedCharges = <
  TSchema extends v.GenericSchema<{ charges: { chargeId: number }[] }>,
>(
  schema: TSchema,
  nameOf: (charge: v.InferOutput<TSchema>["charges"][number]) => string,
) =>
  v.pipe(
    schema,
    v.check(
      (snapshot) =>
        listsEachOnce(snapshot.charges.map((charge) => charge.chargeId)) &&
        listsEachOnce(snapshot.charges.map(nameOf)),
      "Reviewed money must not list the same charge twice",
    ),
  );

const reviewedChargeSchema = v.pipe(
  v.strictObject({
    ...reviewedMoneyFields,
    providerReference: ProviderChargeResourceSchema,
    refunded: MoneySchema,
  }),
  v.check(
    (charge) => refundFitsInsideCapture(charge),
    "Money returned must fit inside the money taken, in the same currency",
  ),
);

const reviewedLegacyChargeSchema = v.strictObject({
  chargeId: integerAtLeast(1),
  // A reference of only spaces names no money for the worker to attach.
  providerReference: ResourceIdSchema,
});

export const PaymentChargeDecisionSnapshotSchema = withNoRepeatedCharges(
  v.pipe(
    v.strictObject({
      accountId: ResourceIdSchema,
      charges: v.pipe(v.array(reviewedChargeSchema), v.minLength(1)),
      kind: v.literal("charges"),
      mode: PaymentModeSchema,
      paymentId: ResourceIdSchema,
      provider: PaymentProviderSchema,
    }),
    // The worker acts through the provider named here, so every piece of money
    // it is shown has to be money that provider took.
    v.check(
      (snapshot) =>
        snapshot.charges.every(
          (charge) => charge.providerReference.provider === snapshot.provider,
        ),
      "Reviewed money must come from the provider the decision names",
    ),
  ),
  (charge) => charge.providerReference.id,
);
export type PaymentChargeDecisionSnapshot = v.InferOutput<
  typeof PaymentChargeDecisionSnapshotSchema
>;

export const PaymentLegacyDecisionSnapshotSchema = withNoRepeatedCharges(
  v.strictObject({
    charges: v.pipe(v.array(reviewedLegacyChargeSchema), v.minLength(1)),
    kind: v.literal("legacy_assignment"),
    paymentId: ResourceIdSchema,
  }),
  (charge) => charge.providerReference,
);
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
  v.pipe(
    v.strictObject({
      ...decisionBase,
      ...paymentAccountFields,
      kind: v.literal("assign_provider"),
      read: v.nullable(LegacyProviderAssignmentReadSchema),
    }),
    // The owner is saying which provider took this old payment, so the money
    // shown to them has to be that provider's money.
    v.check(
      (decision) =>
        decision.read === null ||
        decision.read.status !== "attached" ||
        decision.read.session.provider === decision.provider,
      "The money shown must come from the provider being given to the payment",
    ),
  ),
]);
export type PaymentOperatorDecision = v.InferOutput<
  typeof PaymentOperatorDecisionSchema
>;

export const PaymentDecisionStateSchema = v.picklist(DECISION_STATES);
export type PaymentDecisionState = v.InferOutput<
  typeof PaymentDecisionStateSchema
>;
