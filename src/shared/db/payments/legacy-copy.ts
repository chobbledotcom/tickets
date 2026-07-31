import type { InValue } from "@libsql/client";
import { mapParallel } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import {
  paymentStoredJson,
  sealPaymentCaseData,
} from "#shared/db/payments/codecs.ts";
import {
  type LegacyPaymentGroup,
  type LegacyPaymentRuntime,
  legacySessionFields,
} from "#shared/db/payments/legacy.ts";
import type {
  LegacyPaymentSource,
  PaymentCaseEvidence,
  PaymentCaseResource,
} from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import type { ProviderSessionResource } from "#shared/payment-state/resources.ts";

type LegacyAction = {
  evidence: PaymentCaseEvidence;
  reason: string;
  resource: PaymentCaseResource;
  state: "needs_action" | "resolved";
};

export type PreparedLegacyAction = LegacyAction & {
  encryptedEvidence: EnvKeyEncrypted;
  encryptedResource: EnvKeyEncrypted;
  resourceIndex: string;
};

export type PreparedLegacyPayment = {
  actions: PreparedLegacyAction[];
  fields: ReturnType<typeof legacySessionFields>;
  id: string;
  runtime: LegacyPaymentRuntime;
  storedRuntime: EnvKeyEncrypted;
};

type LegacySourceEvidence = {
  legacyPaymentId: string;
  providerRefundedAt: string;
  source: LegacyPaymentSource;
};

const sourceAction = (
  paymentId: string,
  source: LegacySourceEvidence,
  fact: "lifecycle" | "provider" | "refund_amount",
): LegacyAction => ({
  evidence: {
    fact,
    legacyPaymentId: source.legacyPaymentId,
    providerRefundedAt: source.providerRefundedAt,
    source: source.source,
  },
  reason: `legacy_${fact}_unknown`,
  resource: {
    id: `${paymentId}:${fact}`,
    kind: "legacy_payment",
    source: source.source,
  },
  state: "needs_action",
});

const actionsFor = (
  paymentId: string,
  runtime: LegacyPaymentRuntime,
): LegacyAction[] => {
  const processed = runtime.processedPayment;
  const attendee = runtime.attendeePayment;
  const attendeeActions =
    attendee === null
      ? []
      : [
          sourceAction(
            paymentId,
            {
              legacyPaymentId: String(attendee.attendeeId),
              providerRefundedAt: "",
              source: attendee.source,
            },
            "provider",
          ),
        ];
  if (processed === null) return attendeeActions;
  const source = {
    legacyPaymentId: processed.paymentSessionId,
    providerRefundedAt: processed.providerRefundedAt,
    source: "processed_payments" as const,
  };
  return [
    ...attendeeActions,
    ...(processed.attendeeId === null && processed.failureData === ""
      ? [sourceAction(paymentId, source, "lifecycle")]
      : []),
    ...(processed.paymentReference === ""
      ? []
      : [sourceAction(paymentId, source, "provider")]),
    ...(processed.providerRefundedAt === ""
      ? []
      : [sourceAction(paymentId, source, "refund_amount")]),
  ];
};

const providerSessionFor = (
  group: LegacyPaymentGroup,
): {
  resource: ProviderSessionResource;
  source: "checkout_stages" | "sumup_checkouts";
} | null => {
  const sumup = group.runtime.sumupCheckout;
  if (sumup !== null && sumup.sumupId !== "") {
    return {
      resource: PAYMENT_PROVIDER_RESOURCES.sumup.session(sumup.sumupId),
      source: "sumup_checkouts",
    };
  }
  const stage = group.runtime.checkoutStage;
  if (stage === null || stage.provider === "sumup") return null;
  return {
    resource: PAYMENT_PROVIDER_RESOURCES[stage.provider].session(
      stage.paymentSessionId,
    ),
    source: "checkout_stages",
  };
};

const aliasFor = (
  paymentId: string,
  group: LegacyPaymentGroup,
): LegacyAction[] => {
  const session = providerSessionFor(group);
  if (session === null) return [];
  return [
    {
      evidence: {
        fact: "provider_session",
        legacyPaymentId: paymentId,
        providerRefundedAt: "",
        source: session.source,
      },
      reason: "legacy_provider_session",
      resource: session.resource,
      state: "resolved",
    },
  ];
};

const prepareAction = async (
  value: LegacyAction,
): Promise<PreparedLegacyAction> => {
  const sealed = await sealPaymentCaseData(value.resource, value.evidence);
  return {
    ...value,
    ...sealed,
  };
};

export const prepareLegacyPayment = async (
  group: LegacyPaymentGroup,
): Promise<PreparedLegacyPayment> => {
  const id = await legacyPaymentId(group);
  const cases = [...actionsFor(id, group.runtime), ...aliasFor(id, group)];
  const [storedRuntime, actions] = await Promise.all([
    paymentStoredJson.legacyRuntime.seal(
      group.runtime,
      "payment_sessions.legacy_runtime",
    ),
    mapParallel(prepareAction)(cases),
  ]);
  return {
    actions,
    fields: legacySessionFields(group),
    id,
    runtime: group.runtime,
    storedRuntime,
  };
};

export const legacyPaymentId = async (
  group: LegacyPaymentGroup,
): Promise<string> => {
  const attendee = group.runtime.attendeePayment;
  if (attendee !== null) return `legacy:attendee:${attendee.attendeeId}`;
  if (group.key.startsWith("sumup:")) {
    return `legacy:sumup:${group.key.slice("sumup:".length)}`;
  }
  return `legacy:session:${await hmacHash(group.key)}`;
};

export const prepareLegacyAttendeePaymentReference = async (
  attendeeId: number,
  paymentReference: string,
  createdAt = nowIso(),
): Promise<PreparedLegacyPayment | null> =>
  paymentReference === ""
    ? null
    : prepareLegacyPayment({
        key: `attendee:${attendeeId}`,
        runtime: {
          attendeePayment: {
            attendeeId,
            createdAt,
            paymentReference: await encryptWithOwnerKey(
              paymentReference,
              settings.publicKey,
            ),
            source: "attendee_merge",
          },
          checkoutStage: null,
          processedPayment: null,
          sumupCheckout: null,
        },
      });

const sessionInsert = (payment: PreparedLegacyPayment): SqlStatement => ({
  args: [
    payment.id,
    payment.fields.provider,
    payment.fields.state,
    payment.fields.createdAt,
    payment.fields.updatedAt,
    payment.fields.attendeeId,
    payment.fields.resultState,
    payment.fields.result,
    payment.fields.ticketState,
    payment.fields.ticketTokens,
    payment.fields.completionState,
    payment.storedRuntime,
  ],
  sql: `INSERT OR IGNORE INTO payment_sessions
    (id, origin, provider, mode, account_id, session_resource,
     session_reference_index, expected_amount, expected_currency,
     booking_intent, state, revision, created_at, updated_at,
     lease_token, lease_expires_at, next_reconcile_at, attendee_id,
     result_state, result, ticket_state, ticket_tokens, completion_state,
     completion, legacy_runtime)
    VALUES (?, 'legacy', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?)`,
});

const chargeInsert = (payment: PreparedLegacyPayment): SqlStatement | null => {
  const processed = payment.runtime.processedPayment;
  const attendee = payment.runtime.attendeePayment;
  if (
    (processed === null || processed.paymentReference === "") &&
    attendee === null
  ) {
    return null;
  }
  const providerReference =
    processed?.paymentReference || attendee?.paymentReference;
  if (providerReference === undefined) {
    throw new Error(`Legacy payment ${payment.id} has no payment evidence`);
  }
  const source = processed === null ? attendee!.source : "processed_payments";
  const observedAt = Date.parse(processed?.processedAt ?? attendee!.createdAt);
  return {
    args: [
      payment.id,
      providerReference,
      processed?.providerRefundedAt || null,
      source,
      observedAt,
      observedAt,
      observedAt,
    ],
    sql: `INSERT OR IGNORE INTO payment_charges
      (payment_id, origin, provider, resource_kind, provider_reference,
       reference_index, captured_amount, currency, refunded_amount,
       refund_state, pending_refund_id, pending_refund_index,
       pending_refund_idempotency_key, pending_refund_key_index,
        provider_refunded_at, legacy_source, created_at, updated_at, observed_at)
       VALUES (?, 'legacy', NULL, NULL, ?, NULL, NULL, NULL, NULL,
         'unknown', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  };
};

const caseInsert = (
  payment: PreparedLegacyPayment,
  paymentCase: PreparedLegacyAction,
): SqlStatement => ({
  args: [
    payment.id,
    paymentCase.encryptedResource,
    paymentCase.resourceIndex,
    paymentCase.reason,
    payment.fields.updatedAt,
    payment.fields.updatedAt,
    paymentCase.state === "needs_action" ? payment.fields.updatedAt : null,
    paymentCase.encryptedEvidence,
    paymentCase.state === "resolved" ? payment.fields.updatedAt : null,
  ],
  sql: `INSERT OR IGNORE INTO payment_cases
     (payment_id, resource, resource_index, reason, state, first_observed_at,
      last_observed_at, next_reconcile_at, consecutive_count, alerted_at,
      alerted_revision, evidence, revision, resolved_at)
     VALUES (?, ?, ?, ?, '${paymentCase.state}', ?, ?, NULL, 1, ?,
       ${paymentCase.state === "needs_action" ? "1" : "NULL"}, ?, 1, ?)`,
});

export const legacyTargetStatements = (
  payment: PreparedLegacyPayment,
): SqlStatement[] => {
  const charge = chargeInsert(payment);
  return [
    sessionInsert(payment),
    ...(charge === null ? [] : [charge]),
    ...payment.actions.map((paymentCase) => caseInsert(payment, paymentCase)),
  ];
};

const deleteStatement = (sql: string, args: InValue[]): SqlStatement => ({
  args,
  sql,
});

export const legacySourceStatements = (
  runtime: LegacyPaymentRuntime,
): SqlStatement[] => {
  const processed = runtime.processedPayment;
  const stage = runtime.checkoutStage;
  const sumup = runtime.sumupCheckout;
  return [
    ...(processed === null
      ? []
      : [
          deleteStatement(
            `DELETE FROM processed_payments
              WHERE payment_session_id = ? AND attendee_id IS ?
                AND processed_at = ? AND ticket_tokens = ?
                AND failure_data = ? AND payment_reference = ?
                AND provider_refunded_at = ?`,
            [
              processed.paymentSessionId,
              processed.attendeeId,
              processed.processedAt,
              processed.ticketTokens,
              processed.failureData,
              processed.paymentReference,
              processed.providerRefundedAt,
            ],
          ),
        ]),
    ...(stage === null
      ? []
      : [
          deleteStatement(
            `DELETE FROM checkout_stages
              WHERE payment_session_id = ? AND attendee_id = ? AND provider = ?
                AND ticket_tokens = ? AND state = ? AND created_at = ?`,
            [
              stage.paymentSessionId,
              stage.attendeeId,
              stage.provider,
              stage.ticketTokens,
              stage.state,
              stage.createdAt,
            ],
          ),
        ]),
    ...(sumup === null
      ? []
      : [
          deleteStatement(
            `DELETE FROM sumup_checkouts
              WHERE reference_index = ? AND wrapped_key = ? AND metadata = ?
                AND sumup_id = ? AND created_at = ?`,
            [
              sumup.referenceIndex,
              sumup.wrappedKey,
              sumup.metadata,
              sumup.sumupId,
              sumup.createdAt,
            ],
          ),
        ]),
  ];
};
