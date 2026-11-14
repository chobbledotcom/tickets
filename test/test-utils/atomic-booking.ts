import { getDb } from "#db/client.ts";
import { type SqlStatement, sql, sqlLiteral, sqlName } from "#db/sql.ts";

const withBookingWriteTrigger = async (
  triggerName: string,
  listingId: number,
  action: SqlStatement,
  body: () => Promise<void>,
): Promise<void> => {
  const db = getDb();
  await db.execute(
    sql`CREATE TRIGGER ${sqlName(triggerName)}
       BEFORE INSERT ON listing_attendees
       WHEN NEW.listing_id = ${sqlLiteral(listingId)}
       BEGIN
         ${action}
       END`,
  );
  try {
    await body();
  } finally {
    await db.execute(sql`DROP TRIGGER ${sqlName(triggerName)}`);
  }
};

/** Abort writes for one listing so caller tests can observe a real unexpected
 * database error after an earlier booking statement has run. */
export const withRejectedBookingWrite = async (
  listingId: number,
  body: () => Promise<void>,
): Promise<void> =>
  withBookingWriteTrigger(
    `test_reject_booking_write_${listingId}`,
    listingId,
    sql`SELECT RAISE(ABORT, 'unexpected booking write');`,
    body,
  );

/** Make one booking insert affect no rows, matching the capacity-guard outcome
 * after an earlier line has already been written. */
export const withSkippedBookingWrite = async (
  listingId: number,
  body: () => Promise<void>,
): Promise<void> =>
  withBookingWriteTrigger(
    `test_skip_booking_write_${listingId}`,
    listingId,
    sql`SELECT RAISE(IGNORE);`,
    body,
  );
