import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  queryBatchPrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#shared/db/client.ts";
import type { PaymentSessionClaim } from "#shared/db/payments/claims.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { withPaymentCompletionClaim } from "#shared/db/payments/completion-effects.ts";
import type {
  PaymentCompletionDeliveryData,
  PreparedPaymentCompletionDelivery,
} from "#shared/payment-completion-delivery.ts";

interface StoredDeliveryRow {
  data: EnvKeyEncrypted;
  delivery_key: string;
  id: number;
}

export interface PaymentCompletionDelivery {
  data: PaymentCompletionDeliveryData;
  id: number;
  key: string;
}

const openDelivery = async (
  row: StoredDeliveryRow,
): Promise<PaymentCompletionDelivery> => ({
  data: await paymentStoredJson.completionDelivery.open(
    row.data,
    `payment_completion_deliveries.data for ${row.id}`,
  ),
  id: row.id,
  key: row.delivery_key,
});

export const storePaymentCompletionDeliveries = async (
  transaction: TxScope,
  paymentId: string,
  deliveries: readonly PreparedPaymentCompletionDelivery[],
): Promise<void> => {
  const statements: SqlStatement[] = await Promise.all(
    deliveries.map(async ({ data, key }) => ({
      args: [
        paymentId,
        key,
        await paymentStoredJson.completionDelivery.seal(
          data,
          "payment_completion_deliveries.data",
        ),
      ],
      sql: `INSERT OR IGNORE INTO payment_completion_deliveries
              (payment_id, delivery_key, data)
            VALUES (?, ?, ?)`,
    })),
  );
  if (statements.length > 0) await transaction.batch(statements);
};

const readDeliveries = async (
  statement: SqlStatement,
): Promise<PaymentCompletionDelivery[]> => {
  const [result] = await queryBatchPrimary([statement]);
  return Promise.all(resultRows<StoredDeliveryRow>(result!).map(openDelivery));
};

/** Load one delivery plus a look-ahead row. The second row tells the caller to
 * pause without another database request after delivering the first. */
export const getPendingPaymentCompletionDeliveries = (
  paymentId: string,
): Promise<PaymentCompletionDelivery[]> =>
  readDeliveries({
    args: [paymentId],
    sql: `SELECT paymentDelivery.id, paymentDelivery.delivery_key,
                 paymentDelivery.data
            FROM payment_completion_deliveries AS paymentDelivery
           WHERE paymentDelivery.payment_id = ?
             AND paymentDelivery.completed_at IS NULL
           ORDER BY paymentDelivery.id
           LIMIT 2`,
  });

export const getPaymentCompletionDeliveriesByKeys = (
  paymentId: string,
  keys: readonly string[],
): Promise<PaymentCompletionDelivery[]> => {
  if (keys.length === 0) return Promise.resolve([]);
  return readDeliveries({
    args: [paymentId, ...keys],
    sql: `SELECT paymentDelivery.id, paymentDelivery.delivery_key,
                 paymentDelivery.data
            FROM payment_completion_deliveries AS paymentDelivery
           WHERE paymentDelivery.payment_id = ?
             AND paymentDelivery.delivery_key IN (${keys.map(() => "?").join(", ")})
           ORDER BY paymentDelivery.id`,
  });
};

export const savePaymentCompletionDeliveryData = async (
  claim: PaymentSessionClaim,
  deliveryId: number,
  data: PaymentCompletionDeliveryData,
): Promise<void> => {
  const stored = await paymentStoredJson.completionDelivery.seal(
    data,
    "payment_completion_deliveries.data",
  );
  await changePaymentCompletionDelivery(
    claim,
    deliveryId,
  )({
    statement: {
      args: [stored, deliveryId, claim.paymentId],
      sql: `UPDATE payment_completion_deliveries
               SET data = ?
             WHERE id = ? AND payment_id = ? AND completed_at IS NULL`,
    },
  });
};

const requireDeliveryChanged = (
  rowsAffected: number,
  deliveryId: number,
): void => {
  if (rowsAffected !== 1) {
    throw new Error(`Payment completion delivery ${deliveryId} changed`);
  }
};

const changePaymentCompletionDelivery =
  (claim: PaymentSessionClaim, deliveryId: number) =>
  ({
    statement,
    work,
  }: {
    statement: SqlStatement;
    work?: ((transaction: TxScope) => Promise<void>) | undefined;
  }): Promise<void> =>
    withPaymentCompletionClaim(claim, async (transaction) => {
      if (work !== undefined) await work(transaction);
      const result = await transaction.execute(statement);
      requireDeliveryChanged(result.rowsAffected, deliveryId);
    });

export const completePaymentCompletionDelivery = (
  claim: PaymentSessionClaim,
  deliveryId: number,
  work?: (transaction: TxScope) => Promise<void>,
): Promise<void> =>
  changePaymentCompletionDelivery(
    claim,
    deliveryId,
  )({
    statement: {
      args: [Date.now(), deliveryId, claim.paymentId],
      sql: `UPDATE payment_completion_deliveries
               SET completed_at = ?
             WHERE id = ? AND payment_id = ? AND completed_at IS NULL`,
    },
    work,
  });
