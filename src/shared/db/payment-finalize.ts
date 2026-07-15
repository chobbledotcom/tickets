import type { InValue } from "@libsql/client";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { encryptPaymentReference } from "#shared/db/payment-references.ts";
import {
  encryptTicketTokens,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";

/** Abort a batch unless the immediately preceding finalize updated one row.
 * `requiredWhen` lets a conditional operation remain a normal no-op when its
 * business precondition no longer holds. */
const paymentFinalizeGuard = (
  requiredWhen = "1 = 1",
  requiredWhenArgs: InValue[] = [],
): SqlStatement => ({
  args: [1, ...requiredWhenArgs],
  sql: `INSERT INTO processed_payments (payment_session_id, processed_at)
        SELECT '', NULL WHERE changes() != ? AND ${requiredWhen}`,
});

const buildFinalizeStatements = async (
  attendeeIdSql: string,
  attendeeIdArgs: InValue[],
  sessionId: string,
  paymentReference: string,
  ticketTokens: string[],
  guard: string,
  guardArgs: InValue[] = [],
): Promise<SqlStatement[]> => [
  {
    args: [
      ...attendeeIdArgs,
      await encryptTicketTokens(ticketTokens),
      await encryptPaymentReference(paymentReference),
      sessionId,
      ...guardArgs,
    ],
    sql: `UPDATE processed_payments
          SET attendee_id = ${attendeeIdSql}, ticket_tokens = ?, payment_reference = ?
          WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION} AND ${guard}`,
  },
  paymentFinalizeGuard(guard, guardArgs),
];

/** Finalize a newly-created attendee and persist its stable ticket token. The
 * returned guard must stay immediately after the UPDATE in the batch. */
export const batchFinalizeStatements = (
  sessionId: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  paymentReference: string,
  ticketToken: string,
): Promise<SqlStatement[]> =>
  buildFinalizeStatements(
    attendeeIdSql,
    [attendeeIdArg],
    sessionId,
    paymentReference,
    [ticketToken],
    "1 = 1",
  );

/** Finalize a balance payment only while the attendee still owes the expected
 * amount. Missing and already-resolved sessions abort the whole settle batch. */
export const balanceFinalizeStatements = (
  sessionId: string,
  attendeeId: number,
  expectedAmount: number,
  paymentReference: string,
): Promise<SqlStatement[]> =>
  buildFinalizeStatements(
    "?",
    [attendeeId],
    sessionId,
    paymentReference,
    [],
    `${attendeeOwedSubquery(String(attendeeId))} = ?`,
    [expectedAmount],
  );
