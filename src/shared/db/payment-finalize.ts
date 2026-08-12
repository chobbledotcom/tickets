import type { InValue } from "@libsql/client";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { preparePaymentReferenceWrite } from "#shared/db/payment-reference-store.ts";
import {
  encryptTicketTokens,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";
import { CLAIM_MIRROR } from "#shared/payment/admit-move.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";

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

/**
 * SQL predicate: no refund run is holding this attendee's payment rows.
 *
 * A run compares the attendee's whole set of charges once and then works from
 * that snapshot, so a charge landing underneath it is refunded by nobody while
 * the run reports success. Read off the plaintext mirror rather than the
 * record, because a live claim always shows as the worst work on the row and
 * this is a plain SQL guard. Kept OUT of the finalize guard's `requiredWhen`
 * on purpose: a held attendee must abort the batch so the callback retries,
 * not pass as a no-op the way a stale business precondition does.
 */
const noRefundRunHolding = (attendeeIdExpr: string): string =>
  `NOT EXISTS (SELECT 1 FROM processed_payments AS holder
     WHERE holder.attendee_id = ${attendeeIdExpr}
       AND holder.protected_state = '${CLAIM_MIRROR}')`;

const buildFinalizeStatements = async (
  attendeeIdSql: string,
  attendeeIdArgs: InValue[],
  sessionId: string,
  paymentReference: PaymentReference | null,
  ticketTokens: string[],
  guard: string,
  guardArgs: InValue[] = [],
  standDownWhen = "1 = 1",
): Promise<SqlStatement[]> => {
  const referenceWrite = await preparePaymentReferenceWrite(paymentReference);
  return [
    {
      args: [
        ...attendeeIdArgs,
        await encryptTicketTokens(ticketTokens),
        referenceWrite.stored?.encrypted ?? "",
        referenceWrite.stored?.index ?? "",
        sessionId,
        ...guardArgs,
        ...referenceWrite.claim.args,
      ],
      // The blind index is written by the same statement as the reference it
      // indexes, so a row can never carry one without the other — a refund claim
      // looks rows up by it to find another row holding the same money.
      sql: `UPDATE processed_payments
          SET attendee_id = ${attendeeIdSql}, ticket_tokens = ?, payment_reference = ?,
              payment_reference_index = ?
          WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}
            AND ${guard} AND ${referenceWrite.claim.sql} AND ${standDownWhen}`,
    },
    paymentFinalizeGuard(guard, guardArgs),
  ];
};

/** Finalize a newly-created attendee and persist its stable ticket token. The
 * returned guard must stay immediately after the UPDATE in the batch. */
export const batchFinalizeStatements = (
  sessionId: string,
  attendeeIdSql: string,
  attendeeIdArg: InValue,
  paymentReference: PaymentReference | null,
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
  paymentReference: PaymentReference,
): Promise<SqlStatement[]> =>
  buildFinalizeStatements(
    "?",
    [attendeeId],
    sessionId,
    paymentReference,
    [],
    `${attendeeOwedSubquery(String(attendeeId))} = ?`,
    [expectedAmount],
    noRefundRunHolding(String(attendeeId)),
  );
