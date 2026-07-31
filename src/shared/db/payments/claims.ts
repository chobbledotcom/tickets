/* jscpd:ignore-start -- imports */
import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { queryOne, type SqlStatement } from "#shared/db/client.ts";
import { claimDatabaseRow } from "#shared/db/lease.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import {
  PAYMENT_SESSION_COLUMNS,
  readPaymentSessionRow,
  type StoredPaymentSessionRow,
  storeSessionProgress,
} from "#shared/db/payments/session-record.ts";
import {
  canChangePaymentSessionState,
  type PaymentCompletion,
  type PaymentSession,
  type PaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import { requirePreviousWrite } from "#shared/db/write-helpers.ts";
import { PaymentSessionStateSchema } from "#shared/payment-state/lifecycle.ts";
import { sameJson } from "#shared/same-json.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export type PaymentSessionClaim = {
  leaseToken: string;
  paymentId: string;
  revision: number;
  state: v.InferOutput<typeof PaymentSessionStateSchema>;
};

export const advancePaymentSessionClaim = (
  claim: PaymentSessionClaim,
  state: PaymentSessionClaim["state"],
): PaymentSessionClaim => ({
  ...claim,
  revision: claim.revision + 1,
  state,
});

const ClaimRowSchema = v.strictObject({
  id: v.string(),
  revision: v.pipe(v.number(), v.safeInteger()),
  state: PaymentSessionStateSchema,
});

const claimPaymentSessionFor =
  (requirement: string) =>
  async (
    paymentId: string,
    leaseMs: number,
  ): Promise<PaymentSessionClaim | null> =>
    claimDatabaseRow(leaseMs)(
      (lease) =>
        queryOne<{ id: string; revision: number; state: string }>(
          `UPDATE payment_sessions
            SET lease_token = ?,
                lease_expires_at = ${DATABASE_NOW_MS} + ?,
                updated_at = MAX(created_at, ${DATABASE_NOW_MS}),
                revision = revision + 1
          WHERE id = ?
            AND origin = 'current'
            AND (lease_token IS NULL OR lease_expires_at <= ${DATABASE_NOW_MS})
            ${requirement}
          RETURNING id, revision, state`,
          [lease.token, lease.duration, paymentId],
        ),
      (raw) => v.parse(ClaimRowSchema, raw),
      (row, leaseToken) => ({
        leaseToken,
        paymentId: row.id,
        revision: row.revision,
        state: row.state,
      }),
    );

type ClaimPaymentSession = (
  paymentId: string,
  leaseMs: number,
) => Promise<PaymentSessionClaim | null>;

export const claimPaymentSession: ClaimPaymentSession =
  claimPaymentSessionFor("");

/** Claim only an unattached current checkout that still has retry input. */
export const claimPaymentCheckoutCreation: ClaimPaymentSession =
  claimPaymentSessionFor(
    "AND state = 'created' AND checkout_create IS NOT NULL",
  );

/** Claim a payment that must exist and be free for this worker. */
export const requirePaymentSessionClaim = async (
  paymentId: string,
  leaseMs: number,
): Promise<PaymentSessionClaim> => {
  const claim = await claimPaymentSession(paymentId, leaseMs);
  if (claim === null) {
    throw new Error(`Could not claim payment session ${paymentId}`);
  }
  return claim;
};

export const paymentSessionClaimError = (claim: PaymentSessionClaim): Error =>
  new Error(`Lost payment session lease for ${claim.paymentId}`);

export const paymentSessionClaimGuardStatement = (
  claim: PaymentSessionClaim,
  requirement = "",
): SqlStatement => ({
  args: [claim.paymentId, claim.leaseToken, claim.revision],
  sql: `UPDATE payment_sessions SET revision = revision
         WHERE id = ? AND lease_token = ? AND revision = ? ${requirement}`,
});

export const releasePaymentSessionClaim = async (
  claim: PaymentSessionClaim,
  nextReconcileAt: number | null,
): Promise<PaymentSession> => {
  const next = v.parse(v.nullable(integerAtLeast(0)), nextReconcileAt);
  return readClaimedPaymentSession(
    claim,
    `UPDATE payment_sessions
        SET lease_token = NULL,
            lease_expires_at = NULL,
            next_reconcile_at = ?,
            updated_at = MAX(created_at, ${DATABASE_NOW_MS}),
            revision = revision + 1
      WHERE id = ? AND lease_token = ? AND revision = ?
      RETURNING ${PAYMENT_SESSION_COLUMNS.join(", ")}`,
    [next, claim.paymentId, claim.leaseToken, claim.revision],
  );
};

export const paymentSessionClaimStatement =
  (release: boolean) =>
  async (
    claim: PaymentSessionClaim,
    progress: PaymentSessionProgress,
  ): Promise<SqlStatement> => {
    if (!canChangePaymentSessionState(claim.state, progress.state)) {
      throw new Error(
        `Payment session cannot change from ${claim.state} to ${progress.state}`,
      );
    }
    const stored = await storeSessionProgress(progress);
    return {
      args: [
        stored.sessionResource,
        stored.state,
        stored.sessionResource,
        stored.sessionReferenceIndex,
        stored.state,
        stored.nextReconcileAt,
        stored.attendeeId,
        stored.resultState,
        stored.result,
        stored.ticketState,
        stored.ticketTokens,
        stored.completionState,
        stored.completion,
        claim.paymentId,
        claim.leaseToken,
        claim.revision,
        claim.state,
      ],
      sql: `UPDATE payment_sessions
        SET checkout_create = CASE
              WHEN ? IS NULL AND ? = 'created' THEN checkout_create
              ELSE NULL
            END,
            session_resource = ?,
            session_reference_index = ?,
            state = ?,
            next_reconcile_at = ?,
            attendee_id = ?,
            result_state = ?,
            result = ?,
            ticket_state = ?,
            ticket_tokens = ?,
            completion_state = ?,
            completion = ?,
             lease_token = ${release ? "NULL" : "lease_token"},
             lease_expires_at = ${release ? "NULL" : "lease_expires_at"},
            updated_at = MAX(created_at, ${DATABASE_NOW_MS}),
            revision = revision + 1
      WHERE id = ? AND lease_token = ? AND revision = ? AND state = ?
       RETURNING ${PAYMENT_SESSION_COLUMNS.join(", ")}`,
    };
  };

const applyPaymentSessionClaimMode = async (
  claim: PaymentSessionClaim,
  statement: SqlStatement,
): Promise<PaymentSession> =>
  readClaimedPaymentSession(claim, statement.sql, statement.args);

const readClaimedPaymentSession = async (
  claim: PaymentSessionClaim,
  sql: string,
  args: InValue[],
): Promise<PaymentSession> => {
  const row = await queryOne<StoredPaymentSessionRow>(sql, args);
  if (row === null) throw paymentSessionClaimError(claim);
  return readPaymentSessionRow(row);
};

type ApplyPaymentSessionClaim = (
  claim: PaymentSessionClaim,
  progress: PaymentSessionProgress,
) => Promise<PaymentSession>;

export const applyPaymentSessionClaim: ApplyPaymentSessionClaim = async (
  claim,
  progress,
) =>
  applyPaymentSessionClaimMode(
    claim,
    await paymentSessionClaimStatement(true)(claim, progress),
  );

export type RetainedPaymentSessionClaim = {
  claim: PaymentSessionClaim;
  payment: PaymentSession;
};

export const applyPaymentSessionClaimKeepingLease = async (
  claim: PaymentSessionClaim,
  progress: PaymentSessionProgress,
): Promise<RetainedPaymentSessionClaim> => ({
  claim: advancePaymentSessionClaim(claim, progress.state),
  payment: await applyPaymentSessionClaimMode(
    claim,
    await paymentSessionClaimStatement(false)(claim, progress),
  ),
});

/** Attach a committed booking to the aggregate without releasing its lease.
 * The following guard rolls the whole caller batch back when the fence is stale. */
export const paymentFulfilmentStatements = async (
  claim: PaymentSessionClaim,
  payment: PaymentSession,
  attendeeIdSql: string,
  attendeeIdArgs: InValue[],
  ticketTokens: string[],
  completion: PaymentCompletion,
  condition?: { args: InValue[]; sql: string },
): Promise<SqlStatement[]> => {
  if (!sameJson(completion.input, payment.bookingIntent)) {
    throw new Error(
      `Payment completion input does not match payment ${payment.id}`,
    );
  }
  const [tokens, sealedCompletion] = await Promise.all([
    ticketTokens.length === 0
      ? null
      : paymentStoredJson.ticketTokens.seal(
          ticketTokens,
          PAYMENT_STORAGE_CONTEXT.sessionTicketTokens,
        ),
    paymentStoredJson.completion.seal(
      completion,
      PAYMENT_STORAGE_CONTEXT.sessionCompletion,
    ),
  ]);
  return [
    paymentSessionClaimGuardStatement(claim, "AND state = 'processing'"),
    requirePreviousWrite(),
    {
      args: [
        ...attendeeIdArgs,
        tokens,
        sealedCompletion,
        claim.paymentId,
        claim.leaseToken,
        claim.revision,
        ...(condition?.args ?? []),
      ],
      sql: `UPDATE payment_sessions
               SET attendee_id = ${attendeeIdSql},
                   ticket_state = '${tokens === null ? "consumed" : "ready"}',
                   ticket_tokens = ?,
                   completion_state = 'pending',
                   completion = ?
              WHERE id = ? AND lease_token = ? AND revision = ?
                AND state = 'processing'
                ${condition === undefined ? "" : `AND ${condition.sql}`}`,
    },
  ];
};
