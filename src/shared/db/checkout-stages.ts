/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { insertManyStatement } from "#shared/accounting/rows.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { attendeeOwnedDeleteStatements } from "#shared/db/attendees/delete.ts";
import {
  execute,
  queryAll,
  queryOnePrimary,
  withTransaction,
} from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import {
  type StoredPaymentFailure,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import {
  PaymentProviderSchema,
  type PaymentProviderType,
} from "#shared/types.ts";
/* jscpd:ignore-end */

export const CheckoutStageStateSchema = v.picklist(["pending", "refunding"]);
export type CheckoutStageState = v.InferOutput<typeof CheckoutStageStateSchema>;

const CheckoutStageRowSchema = v.object({
  attendee_id: v.number(),
  created_at: v.string(),
  payment_session_id: v.string(),
  provider: PaymentProviderSchema,
  provider_checkout_id: v.string(),
  state: CheckoutStageStateSchema,
  ticket_tokens: v.string(),
});

export type CheckoutStage = {
  attendeeId: number;
  createdAt: string;
  paymentSessionId: string;
  provider: PaymentProviderType;
  providerCheckoutId: string;
  state: CheckoutStageState;
  ticketToken: string;
};

export type CheckoutStageCleanup = Omit<CheckoutStage, "ticketToken">;

export type PendingCheckoutStage = {
  paymentSessionId: string;
  provider: PaymentProviderType;
  providerCheckoutId: string;
};

// One selected stage can cost five subrequests: provider close, transaction
// begin, claim, delete batch, and commit. Four stages plus the selection cost 21,
// leaving 29 of Bunny's 50 for scheduled markers, other tasks, and route work.
const CHECKOUT_STAGE_CLEANUP_LIMIT = 4;

export const checkoutStageClaimStatement = (
  stage: Pick<CheckoutStage, "attendeeId" | "paymentSessionId">,
  state: CheckoutStageState,
): { args: InValue[]; sql: string } => ({
  args: [stage.paymentSessionId, stage.attendeeId, state],
  sql: `UPDATE checkout_stages SET state = state
         WHERE payment_session_id = ? AND attendee_id = ? AND state = ?`,
});

export const claimCheckoutStagePayment = (
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
  stage: CheckoutStage,
  state: CheckoutStageState,
): ReturnType<typeof tx.batch> =>
  tx.batch([
    checkoutStageClaimStatement(stage, state),
    {
      args: [stage.paymentSessionId],
      sql: `UPDATE processed_payments SET processed_at = processed_at
             WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    },
  ]);

const checkoutStage = (
  row: v.InferOutput<typeof CheckoutStageRowSchema>,
  ticketToken: string,
): CheckoutStage => ({
  ...checkoutStageWithoutToken(row),
  ticketToken,
});

const checkoutStageWithoutToken = (
  row: Omit<v.InferOutput<typeof CheckoutStageRowSchema>, "ticket_tokens">,
): CheckoutStageCleanup => ({
  attendeeId: row.attendee_id,
  createdAt: row.created_at,
  paymentSessionId: row.payment_session_id,
  provider: row.provider,
  providerCheckoutId: row.provider_checkout_id,
  state: row.state,
});

export const pendingCheckoutStageInsert = async (
  stage: PendingCheckoutStage,
  attendeeIdSql: string,
  attendeeIdArgs: InValue[],
  ticketToken: string,
): Promise<{ sql: string; args: InValue[] }> => ({
  args: [
    stage.paymentSessionId,
    ...attendeeIdArgs,
    stage.provider,
    stage.providerCheckoutId,
    await encrypt(ticketToken),
    "pending",
    nowIso(),
  ],
  sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, provider_checkout_id, ticket_tokens, state, created_at)
        VALUES (?, ${attendeeIdSql}, ?, ?, ?, ?, ?)`,
});

/** Find one stage only when the session, attendee, and plaintext token all match. */
export const findCheckoutStage = async (
  paymentSessionId: string,
  attendeeId: number,
  ticketToken: string,
): Promise<CheckoutStage | null> => {
  const raw = await queryOnePrimary<unknown>(
    `SELECT checkout_stage.payment_session_id, checkout_stage.attendee_id,
            checkout_stage.provider, checkout_stage.provider_checkout_id,
            checkout_stage.ticket_tokens, checkout_stage.state,
            checkout_stage.created_at
       FROM checkout_stages AS checkout_stage
      WHERE checkout_stage.payment_session_id = ?
        AND checkout_stage.attendee_id = ?`,
    [paymentSessionId, attendeeId],
  );
  if (raw === null) return null;
  const row = v.parse(CheckoutStageRowSchema, raw);
  if ((await decrypt(row.ticket_tokens as EnvKeyEncrypted)) !== ticketToken) {
    return null;
  }
  return checkoutStage(row, ticketToken);
};

const checkoutStageFromRow = async (raw: unknown): Promise<CheckoutStage> => {
  const row = v.parse(CheckoutStageRowSchema, raw);
  return checkoutStage(
    row,
    await decrypt(row.ticket_tokens as EnvKeyEncrypted),
  );
};

/** Select only a small oldest-first batch whose provider expiry window passed. */
export const selectOldPendingCheckoutStages = async (
  createdBefore: string,
): Promise<CheckoutStageCleanup[]> => {
  const rows = await queryAll<unknown>(
    `SELECT checkout_stage.payment_session_id, checkout_stage.attendee_id,
            checkout_stage.provider, checkout_stage.provider_checkout_id,
            checkout_stage.state, checkout_stage.created_at
       FROM checkout_stages AS checkout_stage
      WHERE checkout_stage.state = 'pending'
        AND checkout_stage.created_at < ?
      ORDER BY checkout_stage.created_at, checkout_stage.payment_session_id
      LIMIT ?`,
    [createdBefore, CHECKOUT_STAGE_CLEANUP_LIMIT],
  );
  return rows.map((raw) => {
    const row = v.parse(v.omit(CheckoutStageRowSchema, ["ticket_tokens"]), raw);
    return checkoutStageWithoutToken(row);
  });
};

/** Remove a closed stage only if payment has not claimed it in the meantime. */
export const purgePendingCheckoutStage = async (
  stage: CheckoutStageCleanup,
): Promise<boolean> =>
  withTransaction(async (tx) => {
    const claim = await tx.execute({
      args: [stage.paymentSessionId, stage.attendeeId],
      sql: `UPDATE checkout_stages SET state = state
             WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM processed_payments AS payment
                  WHERE payment.payment_session_id = checkout_stages.payment_session_id
               )`,
    });
    if (claim.rowsAffected !== 1) return false;
    await tx.batch([
      ...attendeeOwnedDeleteStatements({ args: [stage.attendeeId], sql: "?" }),
      {
        args: [stage.paymentSessionId, stage.attendeeId],
        sql: `DELETE FROM checkout_stages
               WHERE payment_session_id = ? AND attendee_id = ? AND state = 'pending'`,
      },
      { args: [stage.attendeeId], sql: "DELETE FROM attendees WHERE id = ?" },
    ]);
    return true;
  });

/** Load an open checkout stage from the primary by its payment session. */
export const loadCheckoutStageByPaymentSession = async (
  paymentSessionId: string,
): Promise<CheckoutStage | null> => {
  const row = await queryOnePrimary<unknown>(
    `SELECT checkout_stage.payment_session_id, checkout_stage.attendee_id,
            checkout_stage.provider, checkout_stage.provider_checkout_id,
            checkout_stage.ticket_tokens, checkout_stage.state,
            checkout_stage.created_at
       FROM checkout_stages AS checkout_stage
      WHERE checkout_stage.payment_session_id = ?`,
    [paymentSessionId],
  );
  return row === null ? null : checkoutStageFromRow(row);
};

/** Permanently route a pending stage toward refunding instead of activation. */
export const beginCheckoutStageRefund = async (
  paymentSessionId: string,
): Promise<void> => {
  const result = await execute(
    `UPDATE checkout_stages SET state = 'refunding'
      WHERE payment_session_id = ? AND state = 'pending'`,
    [paymentSessionId],
  );
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Checkout stage ${paymentSessionId} did not enter refunding`,
    );
  }
};

type FinalizeCheckoutStageRefund = {
  failure: StoredPaymentFailure;
  legs: TransferInput[];
  paymentReference: string;
  stage: CheckoutStage;
};

/** Atomically preserve the replay result and refund ledger, then remove the
 * staged attendee while keeping its historical ledger account. */
export const finalizeCheckoutStageRefund = async ({
  failure,
  legs,
  paymentReference,
  stage,
}: FinalizeCheckoutStageRefund): Promise<void> => {
  const recordedAt = nowIso();
  const failureData = await encrypt(JSON.stringify(failure));
  const encryptedReference = await encryptPaymentReference(paymentReference);
  await withTransaction(async (tx) => {
    const [stageClaim, paymentClaim] = await claimCheckoutStagePayment(
      tx,
      stage,
      "refunding",
    );
    if (stageClaim!.rowsAffected !== 1 || paymentClaim!.rowsAffected !== 1) {
      throw new Error(
        `Checkout refund ${stage.paymentSessionId} was not ready to finalize`,
      );
    }
    await tx.batch([
      insertManyStatement(legs, recordedAt),
      {
        args: [
          failureData,
          encryptedReference,
          recordedAt,
          stage.paymentSessionId,
        ],
        sql: `UPDATE processed_payments
                 SET failure_data = ?, payment_reference = ?, provider_refunded_at = ?
               WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
      },
      ...attendeeOwnedDeleteStatements({
        args: [stage.attendeeId],
        sql: "?",
      }),
      {
        args: [stage.paymentSessionId, stage.attendeeId],
        sql: `DELETE FROM checkout_stages
               WHERE payment_session_id = ? AND attendee_id = ? AND state = 'refunding'`,
      },
      {
        args: [stage.attendeeId],
        sql: "DELETE FROM attendees WHERE id = ?",
      },
    ]);
  });
};
