/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { chunk, mapParallel, unique } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import {
  executeBatch,
  inPlaceholders,
  queryBatch,
  queryOne,
  resultRows,
  type SqlStatement,
  withTransaction,
} from "#shared/db/client.ts";
import {
  PAYMENT_CHARGE_COLUMNS,
  readStoredPaymentCharge,
  type StoredChargeRow,
  type StoredCurrentChargeRow,
} from "#shared/db/payments/charge-record.ts";
import { paymentChargeUpsertStatement } from "#shared/db/payments/charge-upsert.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import type {
  PaymentCharge,
  StoredPaymentCharge,
} from "#shared/db/payments/types.ts";
import {
  requireReturnedRows,
  type TimedRowWrite,
  writeRowsAtCurrentTime,
} from "#shared/db/write-helpers.ts";
import {
  type ChargeLeg,
  ChargeLegSchema,
  type Money,
  MoneySchema,
  type ProviderChargeResource,
  type ProviderRefundResource,
  type ProviderSessionResource,
  ProviderSessionResourceSchema,
  RefundResolutionSchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

const columnsSql = PAYMENT_CHARGE_COLUMNS.join(", ");
const PAYMENT_CHARGE_QUERY_SIZE = 500;

const validateResourceParents = (
  session: ProviderSessionResource,
  charge: ChargeLeg,
): void => {
  if (
    charge.resource.provider !== session.provider ||
    charge.resource.parentId !== session.id
  ) {
    throw new Error("Stored charge must belong to its payment session");
  }
  if (
    charge.refunds.some(
      (refund) =>
        refund.refund !== undefined &&
        (refund.refund.provider !== charge.resource.provider ||
          refund.refund.parentId !== charge.resource.id),
    )
  ) {
    throw new Error("Stored refund must belong to its charge");
  }
};

export const paymentChargeStatements = async (
  paymentId: string,
  sessionValue: ProviderSessionResource,
  chargeValues: readonly ChargeLeg[],
  observedAt: number,
): Promise<SqlStatement[]> => {
  const id = v.parse(ResourceIdSchema, paymentId);
  const session = v.parse(ProviderSessionResourceSchema, sessionValue);
  const at = v.parse(integerAtLeast(0), observedAt);
  const charges = chargeValues.map((charge) => {
    const parsed = v.parse(ChargeLegSchema, charge);
    validateResourceParents(session, parsed);
    return parsed;
  });
  return mapParallel((charge: ChargeLeg) =>
    paymentChargeUpsertStatement(id, charge, at),
  )(charges);
};

export const savePaymentCharges = async (
  paymentId: string,
  session: ProviderSessionResource,
  charges: readonly ChargeLeg[],
  observedAt: number,
): Promise<void> => {
  const statements = await paymentChargeStatements(
    paymentId,
    session,
    charges,
    observedAt,
  );
  if (statements.length > 0) await executeBatch(statements);
};

const loadPaymentCharges = async (
  paymentIds: readonly string[],
): Promise<StoredPaymentCharge[]> => {
  if (paymentIds.length === 0) return [];
  const ids = unique([...paymentIds]);
  const results = await queryBatch(
    chunk(PAYMENT_CHARGE_QUERY_SIZE)(ids).map((part) => ({
      args: part,
      sql: `SELECT ${columnsSql}
              FROM payment_charges
             WHERE payment_id IN (${inPlaceholders(part)})
             ORDER BY id`,
    })),
  );
  return mapParallel(readStoredPaymentCharge)(
    results.flatMap((result) => resultRows<StoredChargeRow>(result)),
  );
};

export const getPaymentCharges = (
  paymentId: string,
): Promise<StoredPaymentCharge[]> => loadPaymentCharges([paymentId]);

/** Load every requested payment's charges in one read, preserving charge order. */
export const getPaymentChargesByPaymentIds = async (
  paymentIds: readonly string[],
): Promise<Map<string, StoredPaymentCharge[]>> => {
  const charges = await loadPaymentCharges(paymentIds);
  return Map.groupBy(charges, (charge) => charge.paymentId);
};

export const getPaymentChargeByResourceOrNull = async (
  resource: ProviderChargeResource,
): Promise<PaymentCharge | null> => {
  const referenceIndex = await paymentStoredJson.chargeResource.index(
    resource,
    PAYMENT_STORAGE_CONTEXT.chargeLookup,
  );
  const row = await queryOne<StoredCurrentChargeRow>(
    `SELECT ${columnsSql}
       FROM payment_charges
      WHERE reference_index = ?
      ORDER BY id
      LIMIT 1`,
    [referenceIndex],
  );
  if (row === null) return null;
  return readStoredPaymentCharge(row);
};

export type ChargeRefundRequest = {
  chargeId: number;
  idempotencyKey: string;
};

const chargeById = (chargeId: number): Promise<StoredChargeRow | null> =>
  queryOne<StoredChargeRow>(
    `SELECT ${columnsSql} FROM payment_charges WHERE id = ?`,
    [chargeId],
  );

const validateRefundParent = async (
  chargeId: number,
  refund: ProviderRefundResource | undefined,
): Promise<void> => {
  if (refund === undefined) return;
  const stored = await chargeById(chargeId);
  if (stored === null || stored.origin === "legacy") {
    throw new Error("Stored refund must belong to its charge");
  }
  const charge = await readStoredPaymentCharge(stored);
  if (
    refund.provider !== charge.providerReference.provider ||
    refund.parentId !== charge.providerReference.id
  ) {
    throw new Error("Stored refund must belong to its charge");
  }
};

export const requestChargeRefund = async (
  chargeId: number,
  proposedKey = generateSecureToken(),
  requestedAt = Date.now(),
): Promise<ChargeRefundRequest> => {
  const id = v.parse(integerAtLeast(1), chargeId);
  const key = v.parse(ResourceIdSchema, proposedKey);
  const at = v.parse(integerAtLeast(0), requestedAt);
  const [ciphertext, keyIndex] = await Promise.all([
    encrypt(key),
    hmacHash(key),
  ]);
  const claimed = await queryOne<{ id: number }>(
    `UPDATE payment_charges
        SET refund_state = 'requested',
            pending_refund_idempotency_key = ?,
            pending_refund_key_index = ?,
            updated_at = ?
      WHERE id = ?
        AND refund_state IN ('none', 'partial', 'failed')
        AND pending_refund_idempotency_key IS NULL
        AND refunded_amount < captured_amount
      RETURNING id`,
    [ciphertext, keyIndex, at, id],
  );
  if (claimed !== null) return { chargeId: claimed.id, idempotencyKey: key };
  const existing = await chargeById(id);
  if (existing === null) throw new Error(`Payment charge ${id} was not found`);
  if (existing.pending_refund_idempotency_key === null) {
    throw new Error(
      `Payment charge ${id} cannot be refunded from its current state`,
    );
  }
  return {
    chargeId: id,
    idempotencyKey: await decrypt(existing.pending_refund_idempotency_key),
  };
};

export const applyChargeRefund = async (
  chargeId: number,
  idempotencyKey: string,
  confirmedRefundedValue: Money,
  resolutionValue: v.InferInput<typeof RefundResolutionSchema>,
  observedAt: number,
): Promise<PaymentCharge> => {
  const confirmedRefunded = v.parse(MoneySchema, confirmedRefundedValue);
  const resolution = v.parse(RefundResolutionSchema, resolutionValue);
  const at = v.parse(integerAtLeast(0), observedAt);
  if (resolution.amount.currency !== confirmedRefunded.currency) {
    throw new Error("Refund resolution currency does not match the charge");
  }
  if (
    (resolution.status === "completed" || resolution.status === "partial") &&
    resolution.amount.amount !== confirmedRefunded.amount
  ) {
    throw new Error("Refund resolution amount does not match confirmed money");
  }
  await validateRefundParent(chargeId, resolution.refund);
  const keyIndex = await hmacHash(v.parse(ResourceIdSchema, idempotencyKey));
  const pending =
    resolution.status === "pending" && resolution.refund !== undefined
      ? await paymentStoredJson.refundResource.sealIndexed(
          resolution.refund,
          PAYMENT_STORAGE_CONTEXT.pendingRefund,
        )
      : null;
  const row = await queryOne<StoredCurrentChargeRow>(
    `UPDATE payment_charges
        SET refunded_amount = ?,
            refund_state = ?,
            pending_refund_id = CASE WHEN ? = 'pending'
              THEN COALESCE(?, pending_refund_id) ELSE NULL END,
            pending_refund_index = CASE WHEN ? = 'pending'
              THEN COALESCE(?, pending_refund_index) ELSE NULL END,
             pending_refund_idempotency_key = CASE WHEN ? IN ('pending', 'failed')
               THEN pending_refund_idempotency_key ELSE NULL END,
             pending_refund_key_index = CASE WHEN ? IN ('pending', 'failed')
              THEN pending_refund_key_index ELSE NULL END,
            updated_at = ?,
            observed_at = ?
      WHERE id = ?
        AND pending_refund_key_index = ?
        AND currency = ?
      RETURNING ${columnsSql}`,
    [
      confirmedRefunded.amount,
      resolution.status,
      resolution.status,
      pending === null ? null : pending.ciphertext,
      resolution.status,
      pending === null ? null : pending.index,
      resolution.status,
      resolution.status,
      at,
      at,
      chargeId,
      keyIndex,
      confirmedRefunded.currency,
    ],
  );
  if (row === null)
    throw new Error(`Lost refund request for charge ${chargeId}`);
  return readStoredPaymentCharge(row);
};

export type ConfirmedChargeRefund = {
  captured: PaymentCharge["captured"];
  chargeId: number;
};

const confirmChargesForPayment = (
  paymentId: string,
): TimedRowWrite<ConfirmedChargeRefund, void> =>
  writeRowsAtCurrentTime(async (expected, observedAt) => {
    if (expected.length === 0) {
      throw new Error(`Payment ${paymentId} has no charges to confirm`);
    }
    await withTransaction(async (tx) => {
      const count = await tx.execute({
        args: [paymentId],
        sql: `SELECT COUNT(*) AS count FROM payment_charges
          WHERE payment_id = ? AND origin = 'current'`,
      });
      if (
        Number(resultRows<{ count: number }>(count)[0]?.count) !==
        expected.length
      ) {
        throw new Error(
          `Payment ${paymentId} charges changed before confirmation`,
        );
      }
      for (const charge of expected) {
        const result = await tx.execute({
          args: [
            observedAt,
            observedAt,
            charge.chargeId,
            paymentId,
            charge.captured.amount,
            charge.captured.currency,
          ],
          sql: `UPDATE payment_charges
            SET refunded_amount = captured_amount, refund_state = 'completed',
                pending_refund_id = NULL, pending_refund_index = NULL,
                pending_refund_idempotency_key = NULL,
                pending_refund_key_index = NULL, updated_at = ?, observed_at = ?
            WHERE id = ? AND payment_id = ? AND origin = 'current'
              AND captured_amount = ? AND currency = ?
            RETURNING id`,
        });
        requireReturnedRows<{ id: number }>(
          1,
          `Payment charge ${charge.chargeId} changed before confirmation`,
        )(result);
      }
    });
  });

/** Record an owner's authoritative full-refund evidence for exact charge facts. */
export const confirmChargesFullyRefunded = (
  paymentId: string,
  expected: readonly ConfirmedChargeRefund[],
  observedAt?: number,
): Promise<void> => confirmChargesForPayment(paymentId)(expected, observedAt);

/** Replace one quarantined legacy reference only when typed provider facts are complete. */
export const upgradeLegacyPaymentCharge = async (
  paymentId: string,
  session: ProviderSessionResource,
  charge: ChargeLeg,
  legacyChargeId: number,
  observedAt = Date.now(),
): Promise<void> => {
  const [statement] = await paymentChargeStatements(
    paymentId,
    session,
    [charge],
    observedAt,
  );
  if (statement === undefined) throw new Error("Expected one provider charge");
  await withTransaction(async (tx) => {
    await tx.execute(statement);
    const deleted = await tx.execute({
      args: [legacyChargeId, paymentId],
      sql: `DELETE FROM payment_charges
        WHERE id = ? AND payment_id = ? AND origin = 'legacy' RETURNING id`,
    });
    const removed = resultRows<{ id: number }>(deleted);
    if (removed.length > 1) {
      throw new Error(`Legacy payment ${paymentId} removed several charges`);
    }
  });
};
