import type { InValue } from "@libsql/client";
import { runAttendeePurge } from "#shared/db/attendees/delete.ts";
import {
  execute,
  inPlaceholders,
  type SqlStatement,
} from "#shared/db/client.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

const pendingStageAttendees = (where: string): string =>
  `SELECT stage.attendee_id
     FROM checkout_stages AS stage
    WHERE stage.state = 'pending'
      AND ${where}
      AND NOT EXISTS (
        SELECT 1
          FROM processed_payments AS payment
         WHERE payment.payment_session_id = stage.payment_session_id
      )`;

/** Delete pending checkout PII only while no payment request has claimed it.
 * The shared purge removes every dependent row, with checkout_stages last so
 * its attendee-id query remains usable throughout the batch. */
const discardPendingCheckoutsWhere = (
  where: string,
  args: InValue[],
  leading: SqlStatement[] = [],
): Promise<number> =>
  runAttendeePurge(pendingStageAttendees(where), args, {
    leading,
    stagesLast: true,
  });

/** Discard one or more cancelled sessions through the shared atomic purge. */
export const discardPendingCheckoutSessions = (
  sessionIds: string[],
): Promise<number> =>
  sessionIds.length === 0
    ? Promise.resolve(0)
    : discardPendingCheckoutsWhere(
        `stage.payment_session_id IN (${inPlaceholders(sessionIds)})`,
        sessionIds,
      );

/** Remove old pending stages and their stale payment claims as one transaction,
 * then remove old terminal replay guards without touching their attendees. A
 * fresh or finalized payment row still protects an old pending stage. */
export const pruneCheckoutStageRows = async (
  pendingCutoffIso: string,
  staleReservationCutoffIso: string,
  resolvedCutoffIso: string,
): Promise<number> => {
  const staleReservationDelete: SqlStatement = {
    args: [staleReservationCutoffIso, pendingCutoffIso],
    sql: `DELETE FROM processed_payments AS payment
           WHERE ${UNRESOLVED_RESERVATION}
             AND payment.processed_at < ?
             AND EXISTS (
               SELECT 1 FROM checkout_stages AS stage
                WHERE stage.payment_session_id = payment.payment_session_id
                  AND stage.state = 'pending' AND stage.created_at < ?
             )`,
  };
  const pending = await discardPendingCheckoutsWhere(
    "stage.created_at < ?",
    [pendingCutoffIso],
    [staleReservationDelete],
  );
  const resolved = await execute(
    `DELETE FROM checkout_stages
      WHERE state IN ('booked', 'failed') AND created_at < ?`,
    [resolvedCutoffIso],
  );
  return pending + resolved.rowsAffected;
};
