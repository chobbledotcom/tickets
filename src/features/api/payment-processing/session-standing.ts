/**
 * Where a paid session stands when its sealed order cannot be read. The
 * answer table in missing-order.ts keys on this union, so a new standing is
 * a compile error until every surface says what it answers.
 */

import { bookingEventGroup } from "#accounting/mappers.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { balanceEventGroup } from "#db/attendees/balance.ts";
import { queryOne } from "#db/client.ts";
import { parseSessionFailure } from "#db/processed-payments.ts";
import { sql, sqlList } from "#db/sql.ts";
import type { StoredPaymentFailure } from "#payment/row-state.ts";
import { requireValue } from "#shared/required-value.ts";

/**
 * - booked: the payment row holds the booking.
 * - handled: the payment row holds a final outcome, such as a refund.
 * - recorded: the payment row is gone, but the ledger holds the money, so the
 *   outcome is known only to be final.
 * - open: none of these. The order is lost.
 */
export type SessionStanding =
  | { kind: "booked" }
  | { kind: "handled"; failure: StoredPaymentFailure }
  | { kind: "recorded" }
  | { kind: "open" };

/** Read where a session stands, from its payment row and its ledger groups.
 * The ledger outlives the payment row, so a late replay still reads as
 * settled. */
export const sessionStanding = async (
  sessionId: string,
): Promise<SessionStanding> => {
  const eventGroups = await Promise.all([
    bookingEventGroup(sessionId),
    balanceEventGroup(sessionId),
  ]);
  const read = await queryOne<{
    attendee_id: number | null;
    failure_data: EnvKeyEncrypted | "" | null;
    recorded: number;
  }>(
    sql`SELECT
        (SELECT payment.attendee_id FROM processed_payments AS payment
          WHERE payment.payment_session_id = ${sessionId}) AS attendee_id,
        (SELECT payment.failure_data FROM processed_payments AS payment
          WHERE payment.payment_session_id = ${sessionId}) AS failure_data,
        EXISTS(SELECT 1 FROM transfers AS transfer
                WHERE transfer.event_group IN (${sqlList(eventGroups)})) AS recorded`,
  );
  const row = requireValue(read, "A session-standing read gives one row");
  if (row.attendee_id !== null) return { kind: "booked" };
  const failure = await parseSessionFailure(row.failure_data ?? "");
  if (failure !== null) return { failure, kind: "handled" };
  return row.recorded === 1 ? { kind: "recorded" } : { kind: "open" };
};
