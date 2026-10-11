import { hmacHash } from "#crypto/hashing.ts";
import { executeBatch, queryAllPrimary } from "#db/client.ts";
import { sealedRegistrationPayload } from "#db/registration-notification-work.ts";
import { nowIso } from "#shared/now.ts";
import { schemaMigration } from "./define.ts";
import type { MigrationContext } from "./types.ts";

/** One completed booking the backfill copies in, stamped delivered. */
interface CompletedBookingRow {
  attendee_id: number;
  payment_session_id: string;
  processed_at: string;
}

/** Copy every booking that existed before this table into it, stamped
 * delivered. A booking completed before the work table has no row, and the
 * replay paths would read that absence as owed work and notify the buyer
 * again. The row is the completion decision those bookings never had the
 * chance to write: no ticket token was ever sealed for them, so an empty
 * payload is enough — a delivered row is only ever read for its stamps. */
const backfillCompletedBookings = async (
  _context: MigrationContext,
): Promise<void> => {
  const sealedEmpty = await sealedRegistrationPayload({ ticketToken: "" });
  const chunkSize = 500;
  let after = "";
  for (;;) {
    const rows = await queryAllPrimary<CompletedBookingRow>({
      args: [after, chunkSize],
      sql: `SELECT payment_session_id, attendee_id, processed_at
              FROM processed_payments
             WHERE attendee_id IS NOT NULL
               AND payment_session_id > ?
             ORDER BY payment_session_id
             LIMIT ?`,
    });
    if (rows.length === 0) return;
    await executeBatch(
      await Promise.all(
        rows.map(async (row) => ({
          args: [
            await hmacHash(row.payment_session_id),
            row.attendee_id,
            sealedEmpty,
            nowIso(),
            row.processed_at,
          ],
          sql: `INSERT INTO registration_notification_work
                    (session_index, attendee_id, sealed, delivered_at, created_at)
                  VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(session_index) DO NOTHING`,
        })),
      ),
    );
    after = rows[rows.length - 1]!.payment_session_id;
  }
};

export default schemaMigration(
  "2026-10-11_registration_notification_work",
  "Stage the durable work item that carries a paid booking's registration notification — its sealed ticket token and free texts — beside the booking, with the lease and delivery stamps the replay paths claim it by. Bookings that already completed are copied in stamped delivered, so their first replay does not notify them again",
  {
    newTables: ["registration_notification_work"],
  },
  backfillCompletedBookings,
);
