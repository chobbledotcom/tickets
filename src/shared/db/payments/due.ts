import * as v from "valibot";
import { queryBatchPrimary, resultRows } from "#shared/db/client.ts";
import { PaymentSessionStateSchema } from "#shared/payment-state/lifecycle.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const PAYMENT_RECONCILIATION_PAGE_SIZE = 1;

const DuePaymentSessionStateSchema = v.picklist([
  "created",
  "pending",
  "ready",
  "processing",
  "refunding",
  "completed",
  "fully_refunded",
]);

const DuePaymentSessionRowSchema = v.strictObject({
  bulk_refund: v.picklist([0, 1]),
  id: v.string(),
  next_reconcile_at: integerAtLeast(0),
  provider: PaymentProviderSchema,
  state: PaymentSessionStateSchema,
});

export type DuePaymentSession = {
  bulkRefund: boolean;
  id: string;
  nextReconcileAt: number;
  provider: v.InferOutput<typeof PaymentProviderSchema>;
  state: v.InferOutput<typeof DuePaymentSessionStateSchema>;
};

/** Read one due payment page from the primary. The later claim owns the work. */
export const getDuePaymentSessionsPrimary = async (): Promise<
  DuePaymentSession[]
> => {
  const [result] = await queryBatchPrimary([
    {
      args: [PAYMENT_RECONCILIATION_PAGE_SIZE],
      sql: `SELECT paymentSession.id,
                    EXISTS (
                      SELECT 1 FROM payment_cases AS paymentCase
                       WHERE paymentCase.payment_id = paymentSession.id
                         AND paymentCase.reason = 'admin_bulk_refund'
                         AND paymentCase.state = 'retrying'
                    ) AS bulk_refund,
                    paymentSession.provider,
                   paymentSession.state,
                   paymentSession.next_reconcile_at
              FROM payment_sessions AS paymentSession
             WHERE paymentSession.origin = 'current'
               AND paymentSession.next_reconcile_at <= ${DATABASE_NOW_MS}
               AND (paymentSession.lease_token IS NULL
                 OR paymentSession.lease_expires_at <= ${DATABASE_NOW_MS})
               AND (
                 (paymentSession.state = 'created'
                   AND paymentSession.checkout_create IS NOT NULL)
                  OR paymentSession.state IN (
                    'pending', 'ready', 'processing', 'refunding'
                  )
                  OR paymentSession.completion_state = 'pending'
                )
             ORDER BY paymentSession.next_reconcile_at, paymentSession.id
             LIMIT ?`,
    },
  ]);
  return resultRows<unknown>(result!).map((value): DuePaymentSession => {
    const row = v.parse(DuePaymentSessionRowSchema, value);
    return {
      bulkRefund: row.bulk_refund === 1,
      id: row.id,
      nextReconcileAt: row.next_reconcile_at,
      provider: row.provider,
      state: v.parse(DuePaymentSessionStateSchema, row.state),
    };
  });
};
