import { bookingEventGroup } from "#shared/accounting/mappers.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { queryOnePrimary } from "#shared/db/client.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

/** True once local state has a final success/failure or durable money record. */
export const hasTerminalPaymentOutcome = async (
  sessionId: string,
): Promise<boolean> => {
  const [bookingGroup, balanceGroup] = await Promise.all([
    bookingEventGroup(sessionId),
    balanceEventGroup(sessionId),
  ]);
  const result = await queryOnePrimary<{ terminal: number }>(
    `SELECT 1 AS terminal
       WHERE EXISTS (
         SELECT 1 FROM processed_payments AS payment
          WHERE payment.payment_session_id = ?
            AND NOT (${UNRESOLVED_RESERVATION})
       ) OR EXISTS (
         SELECT 1 FROM transfers AS transfer
          WHERE transfer.event_group IN (?, ?)
       )`,
    [sessionId, bookingGroup, balanceGroup],
  );
  return result !== null;
};
