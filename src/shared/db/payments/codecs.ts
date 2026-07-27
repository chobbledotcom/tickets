import * as v from "valibot";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { PaymentCaseEvidenceSchema } from "#shared/db/payments/types.ts";
import { PaymentCheckoutCreateSnapshotSchema } from "#shared/payment-checkout.ts";
import { PaymentCompletionDeliveryDataSchema } from "#shared/payment-completion-delivery.ts";
import {
  PaymentOperatorDecisionClaimSchema,
  PaymentOperatorDecisionSchema,
  PaymentResolutionSchema,
} from "#shared/payment-state/lifecycle.ts";
import {
  ProviderChargeResourceSchema,
  ProviderRefundResourceSchema,
  ProviderSessionResourceSchema,
} from "#shared/payment-state/resources.ts";
import { BookingIntentSchema } from "#shared/payments.ts";
import { LegacyPaymentRuntimeSchema } from "./legacy.ts";
import {
  defineEncryptedStoredJson,
  type EncryptedStoredJson,
} from "./stored-json.ts";
import {
  type PaymentCaseEvidence,
  type PaymentCaseResource,
  PaymentCaseResourceSchema,
  PaymentCompletionSchema,
  PaymentTicketTokensSchema,
} from "./types.ts";

export const paymentStoredJson = {
  bookingIntent: defineEncryptedStoredJson(BookingIntentSchema),
  caseEvidence: defineEncryptedStoredJson(PaymentCaseEvidenceSchema),
  caseResource: defineEncryptedStoredJson(PaymentCaseResourceSchema),
  chargeResource: defineEncryptedStoredJson(ProviderChargeResourceSchema),
  checkoutCreate: defineEncryptedStoredJson(
    PaymentCheckoutCreateSnapshotSchema,
  ),
  completion: defineEncryptedStoredJson(PaymentCompletionSchema),
  completionDelivery: defineEncryptedStoredJson(
    PaymentCompletionDeliveryDataSchema,
  ),
  decision: defineEncryptedStoredJson(PaymentOperatorDecisionSchema),
  decisionClaim: defineEncryptedStoredJson(PaymentOperatorDecisionClaimSchema),
  decisionError: defineEncryptedStoredJson(v.string()),
  legacyRuntime: defineEncryptedStoredJson(LegacyPaymentRuntimeSchema),
  refundResource: defineEncryptedStoredJson(ProviderRefundResourceSchema),
  result: defineEncryptedStoredJson(PaymentResolutionSchema),
  sessionResource: defineEncryptedStoredJson(ProviderSessionResourceSchema),
  ticketTokens: defineEncryptedStoredJson(PaymentTicketTokensSchema),
};

export const PAYMENT_STORAGE_CONTEXT = {
  bookingIntent: "payment_sessions.booking_intent",
  caseEvidence: "payment_cases.evidence",
  caseResource: "payment_cases.resource",
  caseResourceResolution: "payment_cases.resource resolution",
  chargeLookup: "payment_charges.provider_reference lookup",
  chargeReference: "payment_charges.provider_reference",
  completionDelivery: "payment_completion_deliveries.data",
  decision: "payment_case_decisions.decision",
  decisionClaim: "payment_case_decisions.claim",
  decisionError: "payment_case_decisions.last_error",
  pendingRefund: "payment_charges.pending_refund_id",
  sessionCheckoutCreate: "payment_sessions.checkout_create",
  sessionCompletion: "payment_sessions.completion",
  sessionLookup: "payment_sessions.session_resource lookup",
  sessionResource: "payment_sessions.session_resource",
  sessionResult: "payment_sessions.result",
  sessionTicketTokens: "payment_sessions.ticket_tokens",
} as const;

export const openNullablePaymentSessionJson = async <
  TSchema extends v.GenericSchema,
>(
  json: EncryptedStoredJson<TSchema>,
  value: EnvKeyEncrypted | null,
  column: string,
  paymentId: string,
): Promise<v.InferOutput<TSchema> | null> =>
  value === null
    ? null
    : await json.open(value, `payment_sessions.${column} for ${paymentId}`);

export const sealPaymentCaseData = async (
  resourceValue: PaymentCaseResource,
  evidenceValue: PaymentCaseEvidence,
): Promise<{
  encryptedEvidence: EnvKeyEncrypted;
  encryptedResource: EnvKeyEncrypted;
  resourceIndex: string;
}> => {
  const [resource, encryptedEvidence] = await Promise.all([
    paymentStoredJson.caseResource.sealIndexed(
      resourceValue,
      PAYMENT_STORAGE_CONTEXT.caseResource,
    ),
    paymentStoredJson.caseEvidence.seal(
      evidenceValue,
      PAYMENT_STORAGE_CONTEXT.caseEvidence,
    ),
  ]);
  return {
    encryptedEvidence,
    encryptedResource: resource.ciphertext,
    resourceIndex: resource.index,
  };
};

export const openPaymentCaseData = async (
  resourceValue: EnvKeyEncrypted,
  evidenceValue: EnvKeyEncrypted,
  label: string | number,
): Promise<{
  evidence: PaymentCaseEvidence;
  resource: PaymentCaseResource;
}> => {
  const [resource, evidence] = await Promise.all([
    paymentStoredJson.caseResource.open(
      resourceValue,
      `payment_cases.resource for ${label}`,
    ),
    paymentStoredJson.caseEvidence.open(
      evidenceValue,
      `payment_cases.evidence for ${label}`,
    ),
  ]);
  return { evidence, resource };
};
