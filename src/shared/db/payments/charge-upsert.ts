import { mapParallel } from "#fp";
import type { SqlStatement } from "#shared/db/client.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import type { PaymentRefundState } from "#shared/payment-state/lifecycle.ts";
import { resolveRefund } from "#shared/payment-state/refund.ts";
import type {
  ChargeLeg,
  ProviderRefundResource,
} from "#shared/payment-state/resources.ts";

const INSERT_ARGUMENT_COUNT = 14;

const stateOf = (charge: ChargeLeg): PaymentRefundState => {
  if (charge.refunds.length === 0 && charge.confirmedRefunded.amount === 0) {
    return "none";
  }
  return resolveRefund(charge).status;
};

const pendingRefundOf = (charge: ChargeLeg): ProviderRefundResource | null => {
  const pending = charge.refunds.find((refund) => refund.status === "pending");
  return pending?.refund ?? null;
};

const indexRefund = (refund: ProviderRefundResource): Promise<string> =>
  paymentStoredJson.refundResource.index(
    refund,
    PAYMENT_STORAGE_CONTEXT.pendingRefund,
  );

const terminalRefundResources = (charge: ChargeLeg): ProviderRefundResource[] =>
  charge.refunds.flatMap((refund) =>
    (refund.status === "completed" || refund.status === "failed") &&
    refund.refund !== undefined
      ? [refund.refund]
      : [],
  );

export const paymentChargeUpsertStatement = async (
  paymentId: string,
  charge: ChargeLeg,
  observedAt: number,
): Promise<SqlStatement> => {
  const terminalRefunds = charge.refunds.filter(
    (refund) => refund.status === "completed" || refund.status === "failed",
  );
  const terminalIndexes = await mapParallel(indexRefund)(
    terminalRefundResources(charge),
  );
  const exactTerminalSql =
    terminalIndexes.length === 0
      ? "0"
      : `payment_charges.pending_refund_index IN (${terminalIndexes
          .map((_index, offset) => `?${INSERT_ARGUMENT_COUNT + offset + 1}`)
          .join(", ")})`;
  const resourceLessTerminalSql =
    terminalRefunds.length === 0
      ? "0"
      : `(payment_charges.refund_state = 'pending'
          AND payment_charges.pending_refund_index IS NULL)`;
  const terminalSql = `(excluded.refunded_amount = excluded.captured_amount
      OR ${exactTerminalSql} OR ${resourceLessTerminalSql})`;
  const unresolvedSql = `payment_charges.refund_state IN ('requested', 'pending')
      AND NOT ${terminalSql}`;
  const unobservedPendingRefundSql = `${unresolvedSql}
      AND excluded.refund_state != 'pending'`;
  const reference = await paymentStoredJson.chargeResource.sealIndexed(
    charge.resource,
    PAYMENT_STORAGE_CONTEXT.chargeReference,
  );
  const pendingRefund = pendingRefundOf(charge);
  const pending =
    pendingRefund === null
      ? null
      : await paymentStoredJson.refundResource.sealIndexed(
          pendingRefund,
          PAYMENT_STORAGE_CONTEXT.pendingRefund,
        );
  const refundState = stateOf(charge);
  const pendingCiphertext = pending === null ? null : pending.ciphertext;
  const pendingIndex = pending === null ? null : pending.index;
  return {
    args: [
      paymentId,
      charge.resource.provider,
      charge.resource.kind,
      reference.ciphertext,
      reference.index,
      charge.captured.amount,
      charge.captured.currency,
      charge.confirmedRefunded.amount,
      refundState,
      pendingCiphertext,
      pendingIndex,
      observedAt,
      observedAt,
      observedAt,
      ...terminalIndexes,
    ],
    sql: `INSERT INTO payment_charges
            (payment_id, origin, provider, resource_kind, provider_reference,
              reference_index, captured_amount, currency, refunded_amount,
             refund_state, pending_refund_id, pending_refund_index,
             created_at, updated_at, observed_at)
          VALUES (?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(payment_id, reference_index) DO UPDATE SET
            provider = excluded.provider,
            resource_kind = excluded.resource_kind,
            provider_reference = excluded.provider_reference,
            captured_amount = excluded.captured_amount,
            currency = excluded.currency,
            refunded_amount = CASE
              WHEN ${unresolvedSql}
              THEN MAX(payment_charges.refunded_amount,
                excluded.refunded_amount)
              ELSE excluded.refunded_amount
            END,
            refund_state = CASE
              WHEN ${unobservedPendingRefundSql}
              THEN payment_charges.refund_state
              ELSE excluded.refund_state
            END,
            pending_refund_id = CASE
              WHEN excluded.refund_state = 'pending'
              THEN COALESCE(excluded.pending_refund_id,
                payment_charges.pending_refund_id)
              WHEN ${unobservedPendingRefundSql}
              THEN payment_charges.pending_refund_id
              ELSE excluded.pending_refund_id
            END,
            pending_refund_index = CASE
              WHEN excluded.refund_state = 'pending'
              THEN COALESCE(excluded.pending_refund_index,
                payment_charges.pending_refund_index)
              WHEN ${unobservedPendingRefundSql}
              THEN payment_charges.pending_refund_index
              ELSE excluded.pending_refund_index
            END,
            pending_refund_idempotency_key = CASE
              WHEN excluded.refund_state = 'pending'
                OR (${unobservedPendingRefundSql})
              THEN payment_charges.pending_refund_idempotency_key
              ELSE NULL
            END,
            pending_refund_key_index = CASE
              WHEN excluded.refund_state = 'pending'
                OR (${unobservedPendingRefundSql})
              THEN payment_charges.pending_refund_key_index
              ELSE NULL
            END,
            updated_at = excluded.updated_at,
            observed_at = excluded.observed_at`,
  };
};
