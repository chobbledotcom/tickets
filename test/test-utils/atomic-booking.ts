import { getDb } from "#shared/db/client.ts";

/** Abort writes for one listing so caller tests can observe a real unexpected
 * database error after an earlier booking statement has run. */
export const withRejectedBookingWrite = async (
  listingId: number,
  body: () => Promise<void>,
): Promise<void> => {
  const db = getDb();
  const triggerName = `test_reject_booking_write_${listingId}`;
  await db.execute(
    `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON listing_attendees
       WHEN NEW.listing_id = ${listingId}
       BEGIN
         SELECT RAISE(ABORT, 'unexpected booking write');
       END`,
  );
  try {
    await body();
  } finally {
    await db.execute(`DROP TRIGGER ${triggerName}`);
  }
};

/** Make one booking insert affect no rows, matching the capacity-guard outcome
 * after an earlier line has already been written. */
export const withSkippedBookingWrite = async (
  listingId: number,
  body: () => Promise<void>,
): Promise<void> => {
  const db = getDb();
  const triggerName = `test_skip_booking_write_${listingId}`;
  await db.execute(
    `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON listing_attendees
       WHEN NEW.listing_id = ${listingId}
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
  );
  try {
    await body();
  } finally {
    await db.execute(`DROP TRIGGER ${triggerName}`);
  }
};
