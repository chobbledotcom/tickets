import { attendeeOwedSubquery } from "#accounting/projection-sql.ts";

import { preparePaymentReferenceWrite } from "#db/payment-reference-store.ts";
import {
  encryptTicketTokens,
  UNRESOLVED_RESERVATION,
} from "#db/processed-payments.ts";
import { equal, type Operand, valued } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlSlot, type SqlStatement, sql, sqlLiteral } from "#db/sql.ts";
import { update } from "#db/write.ts";
import { CLAIM_MIRROR } from "#payment/admit-move.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";

/** Abort a batch unless the immediately preceding finalize updated one row.
 * `requiredWhen` lets a conditional operation remain a normal no-op when its
 * business precondition no longer holds. */
const paymentFinalizeGuard = (
  requiredWhen: SqlStatement = sql`1 = 1`,
): SqlStatement =>
  sql`INSERT INTO processed_payments (payment_session_id, processed_at)
        SELECT '', NULL WHERE changes() != ${1} AND ${requiredWhen}`;

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
const noRefundRunHolding = (attendeeId: SqlSlot): SqlStatement =>
  sql`NOT EXISTS (SELECT 1 FROM processed_payments AS holder
     WHERE holder.attendee_id = ${attendeeId}
       AND holder.protected_state = ${sqlLiteral(CLAIM_MIRROR)})`;

/** A condition that always holds. */
const ALWAYS = sql`1 = 1`;

/** What one finalize writes, and the conditions it writes under. */
type FinalizeWrite = {
  attendeeId: Operand<number>;
  guard?: SqlStatement;
  paymentReference: TaggedPaymentReference | null;
  sessionId: string;
  standDownWhen?: SqlStatement;
  ticketTokens: string[];
};

const buildFinalizeStatements = async ({
  attendeeId,
  guard = ALWAYS,
  paymentReference,
  sessionId,
  standDownWhen = ALWAYS,
  ticketTokens,
}: FinalizeWrite): Promise<SqlStatement[]> => {
  const referenceWrite = await preparePaymentReferenceWrite(paymentReference);
  return [
    // The blind index is written by the same statement as the reference it
    // indexes, so a row can never carry one without the other — a refund claim
    // looks rows up by it to find another row holding the same money.
    update(tables.processed_payments, {
      attendee_id: attendeeId,
      payment_reference: referenceWrite.stored?.encrypted ?? "",
      payment_reference_index: referenceWrite.stored?.index ?? "",
      ticket_tokens: await encryptTicketTokens(ticketTokens),
    }).where((payment) => [
      equal(payment.payment_session_id, sessionId),
      valued(UNRESOLVED_RESERVATION),
      valued(guard),
      valued(referenceWrite.claim),
      valued(standDownWhen),
    ]),
    paymentFinalizeGuard(guard),
  ];
};

/** Finalize a newly-created attendee and persist its stable ticket token. The
 * returned guard must stay immediately after the UPDATE in the batch. */
export const batchFinalizeStatements = (
  sessionId: string,
  attendeeId: number | SqlStatement,
  paymentReference: TaggedPaymentReference | null,
  ticketToken: string,
): Promise<SqlStatement[]> =>
  buildFinalizeStatements({
    attendeeId: valued(sql`${attendeeId}`),
    paymentReference,
    sessionId,
    ticketTokens: [ticketToken],
  });

/** Finalize a balance payment only while the attendee still owes the expected
 * amount. Missing and already-resolved sessions abort the whole settle batch. */
export const balanceFinalizeStatements = (
  sessionId: string,
  attendeeId: number,
  expectedAmount: number,
  paymentReference: TaggedPaymentReference,
): Promise<SqlStatement[]> =>
  buildFinalizeStatements({
    attendeeId,
    guard: sql`${attendeeOwedSubquery(String(attendeeId))} = ${expectedAmount}`,
    paymentReference,
    sessionId,
    standDownWhen: noRefundRunHolding(attendeeId),
    ticketTokens: [],
  });
