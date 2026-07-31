import {
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import {
  type PaymentSessionClaim,
  paymentSessionClaimError,
  paymentSessionClaimGuardStatement,
} from "#shared/db/payments/claims.ts";
import type { PaymentCompletionEffect } from "#shared/payment-completion.ts";

type EffectReceipt = { record_id: number | null };
type CompletionEffectWork = (transaction: TxScope) => Promise<number | null>;

export const requireCurrentPaymentCompletionClaim = async (
  transaction: TxScope,
  claim: PaymentSessionClaim,
): Promise<void> => {
  const result = await transaction.execute(
    paymentSessionClaimGuardStatement(claim),
  );
  if (result.rowsAffected !== 1) {
    throw paymentSessionClaimError(claim);
  }
};

export const withPaymentCompletionClaim = <T>(
  claim: PaymentSessionClaim,
  work: (transaction: TxScope) => Promise<T>,
): Promise<T> =>
  withTransaction(async (transaction) => {
    await requireCurrentPaymentCompletionClaim(transaction, claim);
    return work(transaction);
  });

const effectReceipt =
  (transaction: TxScope) =>
  async (
    paymentId: string,
    effect: PaymentCompletionEffect,
  ): Promise<EffectReceipt> => {
    const rows = resultRows<EffectReceipt>(
      await transaction.execute({
        args: [paymentId, effect],
        sql: `SELECT paymentEffect.record_id
              FROM payment_completion_effects AS paymentEffect
             WHERE paymentEffect.payment_id = ? AND paymentEffect.effect = ?`,
      }),
    );
    const receipt = rows[0];
    if (receipt === undefined) {
      throw new Error(`Missing ${effect} receipt for payment ${paymentId}`);
    }
    return receipt;
  };

/** Run one local database effect once. The claim check, receipt, and domain
 * writes share one transaction, so a crash cannot leave an activity or answer
 * without the receipt that makes its replay a no-op. */
export const runPaymentCompletionDbEffect = (
  claim: PaymentSessionClaim,
  effect: PaymentCompletionEffect,
  work: CompletionEffectWork,
): Promise<number | null> =>
  withPaymentCompletionClaim(claim, async (transaction) => {
    const inserted = await transaction.execute({
      args: [claim.paymentId, effect, Date.now()],
      sql: `INSERT OR IGNORE INTO payment_completion_effects
              (payment_id, effect, completed_at)
            VALUES (?, ?, ?)`,
    });
    if (inserted.rowsAffected === 0) {
      return (await effectReceipt(transaction)(claim.paymentId, effect))
        .record_id;
    }
    const recordId = await work(transaction);
    if (recordId !== null) {
      await transaction.execute({
        args: [recordId, claim.paymentId, effect],
        sql: `UPDATE payment_completion_effects
                 SET record_id = ?
               WHERE payment_id = ? AND effect = ?`,
      });
    }
    return recordId;
  });

export const requirePaymentCompletionRecordId = async (
  transaction: TxScope,
  paymentId: string,
  effect: PaymentCompletionEffect,
): Promise<number> => {
  const recordId = (await effectReceipt(transaction)(paymentId, effect))
    .record_id;
  if (recordId === null) {
    throw new Error(`Payment ${paymentId} effect ${effect} has no record`);
  }
  return recordId;
};
