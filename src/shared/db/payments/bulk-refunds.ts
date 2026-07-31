import { executeBatchWithResults, inPlaceholders } from "#shared/db/client.ts";
import { resolvePaymentCases } from "#shared/db/payments/case-resolution-batch.ts";
import {
  paymentCaseStatement,
  recordPaymentCase,
} from "#shared/db/payments/cases.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import {
  requireReturnedRows,
  type TimedRowWrite,
  writeRowsAtCurrentTime,
} from "#shared/db/write-helpers.ts";

export const ADMIN_BULK_REFUND_REASON = "admin_bulk_refund";

const paymentResource = (payment: PaymentSession) => {
  if (payment.session === null) {
    throw new Error(`Refund payment ${payment.id} has no provider session`);
  }
  return payment.session;
};

const bulkRefundObservation = (
  payment: PaymentSession,
  state: "needs_action" | "retrying",
  observedAt: number,
) => ({
  evidence: payment.bookingIntent,
  nextReconcileAt: state === "retrying" ? observedAt + 60_000 : null,
  paymentId: payment.id,
  reason: ADMIN_BULK_REFUND_REASON,
  resource: paymentResource(payment),
  state,
});

const queueBulkRefundPaymentsAt = async (
  paymentValues: readonly PaymentSession[],
  observedAt: number,
): Promise<void> => {
  const payments = [
    ...new Map(paymentValues.map((payment) => [payment.id, payment])).values(),
  ];
  if (payments.length === 0) return;
  const cases = await Promise.all(
    payments.map((payment) =>
      paymentCaseStatement(
        bulkRefundObservation(payment, "retrying", observedAt),
        observedAt,
      ),
    ),
  );
  const results = await executeBatchWithResults([
    {
      args: [observedAt, observedAt, ...payments.map(({ id }) => id)],
      sql: `UPDATE payment_sessions
               SET state = 'refunding', next_reconcile_at = ?, updated_at = ?,
                   revision = revision + 1
             WHERE origin = 'current'
               AND id IN (${inPlaceholders(payments)})
             RETURNING id`,
    },
    ...cases,
  ]);
  requireReturnedRows<{ id: string }>(
    payments.length,
    "Not every bulk refund payment was queued",
  )(results[0]);
};

/** Persist every selected payment before any provider request is sent. */
export const queueBulkRefundPayments: TimedRowWrite<PaymentSession, void> =
  writeRowsAtCurrentTime(queueBulkRefundPaymentsAt);

export const resolveQueuedBulkRefundPayments = (
  payments: readonly PaymentSession[],
): Promise<void> =>
  resolvePaymentCases(
    payments.map((payment) => ({
      paymentId: payment.id,
      resource: paymentResource(payment),
    })),
  );

export const requireBulkRefundAction = (
  payment: PaymentSession,
): ReturnType<typeof recordPaymentCase> =>
  recordPaymentCase(bulkRefundObservation(payment, "needs_action", Date.now()));
