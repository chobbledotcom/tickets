import type { InValue } from "@libsql/client";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

const buildFinalizeStatement = async (
  attendeeId: number,
  sessionId: string,
  paymentReference: string,
  guard: string,
  extraArgs: InValue[] = [],
): Promise<SqlStatement> => ({
  args: [
    attendeeId,
    await encryptPaymentReference(paymentReference),
    sessionId,
    ...extraArgs,
  ],
  sql: `UPDATE processed_payments SET attendee_id = ?, ticket_tokens = '', payment_reference = ? WHERE payment_session_id = ? AND ${guard}`,
});

/**
 * Build the finalize UPDATE for the single-batch booking path, where the attendee
 * row is inserted earlier in the same batch so its id isn't a literal yet.
 */
export const batchFinalizeStatement = async (
  sessionId: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  guard: SqlStatement,
  paymentReference: string,
): Promise<SqlStatement> => ({
  args: [
    attendeeIdArg,
    await encryptPaymentReference(paymentReference),
    sessionId,
    ...guard.args,
  ],
  sql: `UPDATE processed_payments SET attendee_id = ${attendeeIdSql}, payment_reference = ?
        WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION} AND ${guard.sql}`,
});

/**
 * Build the finalize UPDATE for a balance-payment session, guarded so it only
 * applies while the attendee's balance still equals the amount being settled.
 */
export const balanceFinalizeStatement = async (
  sessionId: string,
  attendeeId: number,
  expectedAmount: number,
  paymentReference: string,
): Promise<SqlStatement> =>
  buildFinalizeStatement(
    attendeeId,
    sessionId,
    paymentReference,
    `${attendeeOwedSubquery(String(attendeeId))} = ?`,
    [expectedAmount],
  );
