/**
 * What an owner may decide about a payment, and what they were shown when they
 * decided it.
 *
 * Kept apart from the lifecycle contracts because this is a different system:
 * those say what a reading of a payment means, these say what a person chose
 * to do about one, and the money each choice was made against.
 */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { unique } from "#fp";
import { PaymentModeSchema } from "#shared/payment-state/observation.ts";
import {
  LegacyProviderAssignmentReadSchema,
  refundFitsInsideCapture,
} from "#shared/payment-state/operator.ts";
import {
  MoneySchema,
  PositiveMoneySchema,
  ProviderChargeResourceSchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { DECISION_STATES } from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { kindObject } from "#shared/validation/kind.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

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
 *  payment, so it is given here. A list that carries no provider name gives
 *  none, and is checked on its ids alone. */
const withNoRepeatedCharges = <
  TSchema extends v.GenericSchema<{ charges: { chargeId: number }[] }>,
>(
  schema: TSchema,
  nameOf?: (charge: v.InferOutput<TSchema>["charges"][number]) => string,
) =>
  v.pipe(
    schema,
    v.check(
      (snapshot) =>
        listsEachOnce(snapshot.charges.map((charge) => charge.chargeId)) &&
        (nameOf === undefined || listsEachOnce(snapshot.charges.map(nameOf))),
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
  withNoRepeatedCharges(
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
  ),
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
