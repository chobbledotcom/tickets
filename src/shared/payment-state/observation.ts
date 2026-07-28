import * as v from "valibot";
import {
  type ChargeLeg,
  ChargeLegsSchema,
  MoneySchema,
  type ProviderResource,
  ProviderResourceSchema,
  ProviderSessionResourceSchema,
  providerRefundResources,
  ResourceIdSchema,
  sameProviderResource,
} from "#shared/payment-state/resources.ts";
import { BookingIntentSchema } from "#shared/payments.ts";
import { isInstant } from "#shared/validation/timestamp.ts";

export const PaymentModeSchema = v.picklist(["test", "live"]);
export type PaymentMode = v.InferOutput<typeof PaymentModeSchema>;

export const PaymentInstantSchema = v.pipe(
  v.string(),
  v.check(isInstant, "Payment creation time must be a real instant"),
);

export const PaymentOwnershipProofSchema = v.variant("method", [
  v.strictObject({
    localPaymentId: ResourceIdSchema,
    method: v.literal("signed"),
    signature: ResourceIdSchema,
  }),
  v.strictObject({
    localPaymentId: ResourceIdSchema,
    method: v.literal("staged"),
    stageId: ResourceIdSchema,
  }),
]);
export type PaymentOwnershipProof = v.InferOutput<
  typeof PaymentOwnershipProofSchema
>;

export const signedPaymentOwnership = (
  localPaymentId: string,
  signature: string,
): Extract<PaymentOwnershipProof, { method: "signed" }> => ({
  localPaymentId,
  method: "signed",
  signature,
});

export const stagedPaymentOwnership = (
  localPaymentId: string,
  stageId: string,
): Extract<PaymentOwnershipProof, { method: "staged" }> => ({
  localPaymentId,
  method: "staged",
  stageId,
});

export const ObservedPaymentStatusSchema = v.picklist([
  "pending",
  "paid",
  "no_payment_required",
  "failed",
]);
export type ObservedPaymentStatus = v.InferOutput<
  typeof ObservedPaymentStatusSchema
>;

export const PaymentObservationSchema = v.strictObject({
  accountId: ResourceIdSchema,
  bookingIntent: BookingIntentSchema,
  charges: v.optional(ChargeLegsSchema),
  createdAt: PaymentInstantSchema,
  expected: MoneySchema,
  mode: PaymentModeSchema,
  ownership: PaymentOwnershipProofSchema,
  providerTotal: MoneySchema,
  session: ProviderSessionResourceSchema,
  status: ObservedPaymentStatusSchema,
});
export type PaymentObservation = v.InferOutput<typeof PaymentObservationSchema>;

export const PaymentFactsSchema = v.pick(PaymentObservationSchema, [
  "accountId",
  "bookingIntent",
  "expected",
  "mode",
]);
export type PaymentFacts = v.InferOutput<typeof PaymentFactsSchema>;

export const ProviderNoticeSchema = v.strictObject({
  eventId: ResourceIdSchema,
  resource: ProviderResourceSchema,
  type: ResourceIdSchema,
});
export type ProviderNotice = v.InferOutput<typeof ProviderNoticeSchema>;

export const ProviderMissingReasonSchema = v.literal("not_found");
export type ProviderMissingReason = v.InferOutput<
  typeof ProviderMissingReasonSchema
>;

export const ProviderUnavailableReasonSchema = v.picklist([
  "network_error",
  "provider_unavailable",
  "rate_limited",
  "timed_out",
]);
export type ProviderUnavailableReason = v.InferOutput<
  typeof ProviderUnavailableReasonSchema
>;

export const ProviderInvalidReasonSchema = v.picklist([
  "malformed_response",
  "mismatched_account",
  "missing_documented_resource",
  "mismatched_id",
  "mismatched_parent",
  "unsupported_status",
]);
export type ProviderInvalidReason = v.InferOutput<
  typeof ProviderInvalidReasonSchema
>;

const paymentChargeResources = (charge: ChargeLeg): ProviderResource[] => [
  charge.resource,
  ...providerRefundResources([charge]),
];

export const paymentObservationResources = (
  observation: PaymentObservation,
): ProviderResource[] => {
  const charges = observation.charges;
  return [
    observation.session,
    ...(charges === undefined ? [] : charges.flatMap(paymentChargeResources)),
  ];
};

const returnedResourceBelongsToObservation = (
  observation: PaymentObservation,
  returned: ProviderResource,
): boolean =>
  paymentObservationResources(observation).some((resource) =>
    sameProviderResourceAndParent(resource, returned),
  ) ||
  (observation.status !== "paid" &&
    "parentId" in returned &&
    returned.provider === observation.session.provider &&
    returned.parentId === observation.session.id);

const resourceParent = (resource: ProviderResource): string | undefined =>
  "parentId" in resource ? resource.parentId : undefined;

const sameProviderResourceAndParent = (
  left: ProviderResource,
  right: ProviderResource,
): boolean =>
  sameProviderResource(left, right) &&
  resourceParent(left) === resourceParent(right);

const foundReadSchema = v.pipe(
  v.strictObject({
    observation: PaymentObservationSchema,
    requested: ProviderResourceSchema,
    returned: ProviderResourceSchema,
    status: v.literal("found"),
  }),
  v.check(
    (read) => sameProviderResourceAndParent(read.requested, read.returned),
    "Returned provider resource must match the requested resource",
  ),
  v.check(
    (read) =>
      returnedResourceBelongsToObservation(read.observation, read.returned),
    "Returned provider resource must belong to the payment observation",
  ),
);

const missingReadSchema = v.strictObject({
  ownership: v.optional(PaymentOwnershipProofSchema),
  reason: ProviderMissingReasonSchema,
  requested: ProviderResourceSchema,
  status: v.literal("missing"),
});

const unavailableReadSchema = v.strictObject({
  ownership: v.optional(PaymentOwnershipProofSchema),
  reason: ProviderUnavailableReasonSchema,
  requested: ProviderResourceSchema,
  status: v.literal("unavailable"),
});

const invalidReadSchema = v.strictObject({
  ownership: v.optional(PaymentOwnershipProofSchema),
  reason: ProviderInvalidReasonSchema,
  requested: ProviderResourceSchema,
  returned: v.optional(ProviderResourceSchema),
  status: v.literal("invalid"),
});

export const ProviderReadSchema = v.variant("status", [
  foundReadSchema,
  missingReadSchema,
  unavailableReadSchema,
  invalidReadSchema,
]);
export type ProviderRead = v.InferOutput<typeof ProviderReadSchema>;
