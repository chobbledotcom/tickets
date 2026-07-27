import type { SqlStatement } from "#shared/db/client.ts";

/** Change payment ownership while invalidating any worker using the old owner. */
export const paymentSessionAttendeeChangeStatement = (
  attendeeIds: SqlStatement,
  nextAttendeeId: number | null,
): SqlStatement => ({
  args: [nextAttendeeId, ...attendeeIds.args],
  sql: `UPDATE payment_sessions AS paymentSession
           SET attendee_id = ?,
               lease_token = NULL,
               lease_expires_at = NULL,
               revision = revision + 1
         WHERE paymentSession.attendee_id IN (${attendeeIds.sql})`,
});
