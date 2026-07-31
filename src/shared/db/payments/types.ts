/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { BookingIntentSchema } from "#shared/booking-intent.ts";
import {
  type PaymentCheckoutCreateSnapshot,
  PaymentCheckoutCreateSnapshotSchema,
} from "#shared/payment-checkout.ts";
import {
  type PaymentCompletion,
  PaymentCompletionSchema,
} from "#shared/payment-completion.ts";
import {
  PaymentCaseStateSchema,
  PaymentDecisionStateSchema,
  PaymentOperatorDecisionClaimSchema,
  PaymentOperatorDecisionSchema,
  PaymentRefundStateSchema,
  PaymentResolutionSchema,
  PaymentSessionStateSchema,
} from "#shared/payment-state/lifecycle.ts";
import {
  PaymentModeSchema,
  ProviderReadSchema,
} from "#shared/payment-state/observation.ts";
import {
  MoneySchema,
  ProviderChargeResourceSchema,
  ProviderRefundResourceSchema,
  ProviderResourceSchema,
  ProviderSessionResourceSchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { isInstant } from "#shared/validation/timestamp.ts";

/* jscpd:ignore-end */

const TimestampSchema = integerAtLeast(0);
const RevisionSchema = integerAtLeast(1);
export const StoredPaymentIntegerSchema = v.pipe(v.number(), v.safeInteger());

export const PaymentResultStateSchema = v.picklist([
  "none",
  "succeeded",
  "failed",
]);
export type PaymentResultState = v.InferOutput<typeof PaymentResultStateSchema>;

export const PaymentTicketStateSchema = v.picklist([
  "none",
  "ready",
  "consumed",
]);
export type PaymentTicketState = v.InferOutput<typeof PaymentTicketStateSchema>;

export const PaymentCompletionStateSchema = v.picklist([
  "none",
  "pending",
  "completed",
  "legacy_unknown",
]);
export type PaymentCompletionState = v.InferOutput<
  typeof PaymentCompletionStateSchema
>;

export { type PaymentCompletion, PaymentCompletionSchema };

export const PaymentTicketTokensSchema = v.pipe(
  v.array(ResourceIdSchema),
  v.minLength(1),
);

const PaymentSessionProgressSchema = v.pipe(
  v.strictObject({
    attendeeId: v.nullable(RevisionSchema),
    completion: v.nullable(PaymentCompletionSchema),
    completionState: PaymentCompletionStateSchema,
    nextReconcileAt: v.nullable(TimestampSchema),
    result: v.nullable(PaymentResolutionSchema),
    resultState: PaymentResultStateSchema,
    session: v.nullable(ProviderSessionResourceSchema),
    state: PaymentSessionStateSchema,
    ticketState: PaymentTicketStateSchema,
    ticketTokens: v.nullable(PaymentTicketTokensSchema),
  }),
  v.check(
    (value) => (value.resultState === "none") === (value.result === null),
    "Payment result state must match its stored result",
  ),
  v.check(
    (value) =>
      (value.ticketState === "ready") === (value.ticketTokens !== null),
    "Payment ticket state must match its stored tickets",
  ),
  v.check(
    (value) =>
      (value.completionState === "none") === (value.completion === null),
    "Payment completion state must match its stored completion",
  ),
  v.check(
    (value) => value.completionState !== "legacy_unknown",
    "Current payment progress cannot use legacy completion state",
  ),
  v.check(
    (value) =>
      value.completionState !== "pending" ||
      value.state === "needs_action" ||
      value.nextReconcileAt !== null,
    "Pending payment completion must remain due",
  ),
  v.check(
    (value) =>
      value.session !== null ||
      value.state === "created" ||
      value.state === "failed",
    "A provider session resource is required after successful payment creation",
  ),
);
export type PaymentSessionProgress = v.InferOutput<
  typeof PaymentSessionProgressSchema
>;

export const PaymentSessionCreateSchema = v.pipe(
  v.strictObject({
    accountId: ResourceIdSchema,
    bookingIntent: BookingIntentSchema,
    checkoutCreate: v.nullable(PaymentCheckoutCreateSnapshotSchema),
    expected: MoneySchema,
    id: ResourceIdSchema,
    mode: PaymentModeSchema,
    provider: PaymentProviderSchema,
    session: v.nullable(ProviderSessionResourceSchema),
  }),
  v.check(
    (value) => value.checkoutCreate === null || value.session === null,
    "A created provider session cannot retain checkout creation data",
  ),
  v.check(
    (value) =>
      value.checkoutCreate === null ||
      (value.checkoutCreate.localPaymentId === value.id &&
        JSON.stringify(value.checkoutCreate.bookingIntent) ===
          JSON.stringify(value.bookingIntent) &&
        JSON.stringify(value.checkoutCreate.expected) ===
          JSON.stringify(value.expected)),
    "Payment checkout creation data must match its stored payment facts",
  ),
);
export type PaymentSessionCreate = v.InferOutput<
  typeof PaymentSessionCreateSchema
>;

export interface PaymentSession extends PaymentSessionProgress {
  accountId: string;
  bookingIntent: v.InferOutput<typeof BookingIntentSchema>;
  checkoutCreate: PaymentCheckoutCreateSnapshot | null;
  createdAt: number;
  expected: v.InferOutput<typeof MoneySchema>;
  id: string;
  leaseExpiresAt: number | null;
  mode: v.InferOutput<typeof PaymentModeSchema>;
  provider: v.InferOutput<typeof PaymentProviderSchema>;
  revision: number;
  updatedAt: number;
}

const stateTransitions: Record<
  v.InferOutput<typeof PaymentSessionStateSchema>,
  readonly v.InferOutput<typeof PaymentSessionStateSchema>[]
> = {
  completed: ["completed", "refunding", "fully_refunded", "needs_action"],
  created: [
    "created",
    "pending",
    "ready",
    "processing",
    "failed",
    "needs_action",
  ],
  failed: ["failed", "refunding", "fully_refunded", "needs_action"],
  fully_refunded: ["fully_refunded"],
  needs_action: [
    "needs_action",
    "pending",
    "ready",
    "processing",
    "completed",
    "failed",
    "refunding",
    "fully_refunded",
  ],
  pending: [
    "pending",
    "ready",
    "processing",
    "failed",
    "fully_refunded",
    "needs_action",
  ],
  processing: [
    "processing",
    "completed",
    "failed",
    "refunding",
    "fully_refunded",
    "needs_action",
  ],
  ready: ["ready", "processing", "refunding", "fully_refunded", "needs_action"],
  refunding: ["refunding", "fully_refunded", "failed", "needs_action"],
};

export const canChangePaymentSessionState = (
  from: v.InferOutput<typeof PaymentSessionStateSchema>,
  to: v.InferOutput<typeof PaymentSessionStateSchema>,
): boolean => stateTransitions[from].includes(to);

export const parsePaymentSessionProgress = (
  value: unknown,
): PaymentSessionProgress => v.parse(PaymentSessionProgressSchema, value);

export const PaymentChargeSchema = v.pipe(
  v.strictObject({
    captured: MoneySchema,
    createdAt: TimestampSchema,
    id: RevisionSchema,
    observedAt: TimestampSchema,
    paymentId: ResourceIdSchema,
    pendingRefund: v.nullable(ProviderRefundResourceSchema),
    pendingRefundIdempotencyKey: v.nullable(ResourceIdSchema),
    providerReference: ProviderChargeResourceSchema,
    refunded: MoneySchema,
    refundState: PaymentRefundStateSchema,
    updatedAt: TimestampSchema,
  }),
  v.check(
    (charge) => charge.captured.amount > 0,
    "Stored captured money must be positive",
  ),
  v.check(
    (charge) => charge.captured.currency === charge.refunded.currency,
    "Stored charge money must use one currency",
  ),
  v.check(
    (charge) => charge.refunded.amount <= charge.captured.amount,
    "Stored refunded money cannot exceed captured money",
  ),
  v.check(
    (charge) =>
      charge.pendingRefund === null ||
      (charge.pendingRefund.provider === charge.providerReference.provider &&
        charge.pendingRefund.parentId === charge.providerReference.id),
    "Stored pending refund must belong to its charge",
  ),
);
export type PaymentCharge = v.InferOutput<typeof PaymentChargeSchema>;

export const LegacyPaymentSourceSchema = v.picklist([
  "processed_payments",
  "checkout_stages",
  "sumup_checkouts",
  "attendees.pii_blob",
  "attendee_merge",
]);
export type LegacyPaymentSource = v.InferOutput<
  typeof LegacyPaymentSourceSchema
>;

export const LegacyPaymentChargeSchema = v.strictObject({
  createdAt: TimestampSchema,
  id: RevisionSchema,
  observedAt: TimestampSchema,
  paymentId: ResourceIdSchema,
  providerReference: v.pipe(v.string(), v.startsWith("hyb:1:")),
  providerRefundedAt: v.nullable(v.pipe(v.string(), v.check(isInstant))),
  refundState: v.literal("unknown"),
  source: LegacyPaymentSourceSchema,
  updatedAt: TimestampSchema,
});
export type LegacyPaymentCharge = v.InferOutput<
  typeof LegacyPaymentChargeSchema
>;
export type StoredPaymentCharge = PaymentCharge | LegacyPaymentCharge;

export const LegacyPaymentResourceSchema = v.strictObject({
  id: ResourceIdSchema,
  kind: v.literal("legacy_payment"),
  source: LegacyPaymentSourceSchema,
});
export type LegacyPaymentResource = v.InferOutput<
  typeof LegacyPaymentResourceSchema
>;

export const PaymentCaseResourceSchema = v.union([
  ProviderResourceSchema,
  LegacyPaymentResourceSchema,
]);
export type PaymentCaseResource = v.InferOutput<
  typeof PaymentCaseResourceSchema
>;

export const PaymentCaseEvidenceSchema = v.union([
  BookingIntentSchema,
  v.strictObject({
    kind: v.literal("provider_read"),
    read: ProviderReadSchema,
  }),
  v.strictObject({
    fact: v.picklist([
      "lifecycle",
      "mapping",
      "provider",
      "provider_session",
      "refund_amount",
    ]),
    legacyPaymentId: ResourceIdSchema,
    providerRefundedAt: v.string(),
    source: LegacyPaymentSourceSchema,
  }),
  v.strictObject({
    fact: v.literal("mapping"),
    legacyPaymentIds: v.pipe(v.array(ResourceIdSchema), v.minLength(2)),
    source: v.literal("callback"),
  }),
]);
export type PaymentCaseEvidence = v.InferOutput<
  typeof PaymentCaseEvidenceSchema
>;

export const PaymentCaseSchema = v.strictObject({
  alertedAt: v.nullable(TimestampSchema),
  alertSentAt: v.nullable(TimestampSchema),
  alertSentRevision: v.nullable(RevisionSchema),
  consecutiveCount: RevisionSchema,
  evidence: PaymentCaseEvidenceSchema,
  firstObservedAt: TimestampSchema,
  id: RevisionSchema,
  lastObservedAt: TimestampSchema,
  nextReconcileAt: v.nullable(TimestampSchema),
  paymentId: ResourceIdSchema,
  reason: ResourceIdSchema,
  resolvedAt: v.nullable(TimestampSchema),
  resource: PaymentCaseResourceSchema,
  revision: RevisionSchema,
  state: PaymentCaseStateSchema,
});
export type PaymentCase = v.InferOutput<typeof PaymentCaseSchema>;

export type PaymentCaseObservation = {
  evidence: PaymentCaseEvidence;
  nextReconcileAt: number | null;
  paymentId: string;
  reason: string;
  resource: PaymentCaseResource;
  state: "retrying" | "needs_action";
};

export type PaymentCaseUpdate = {
  alerted: boolean;
  paymentCase: PaymentCase;
};

export const PaymentCaseDecisionSchema = v.strictObject({
  attemptCount: integerAtLeast(0),
  claim: PaymentOperatorDecisionClaimSchema,
  decision: v.nullable(PaymentOperatorDecisionSchema),
  id: RevisionSchema,
  lastAttemptAt: v.nullable(TimestampSchema),
  nextRetryAt: v.nullable(TimestampSchema),
  paymentCaseId: RevisionSchema,
  state: PaymentDecisionStateSchema,
});
export type PaymentCaseDecision = v.InferOutput<
  typeof PaymentCaseDecisionSchema
>;
