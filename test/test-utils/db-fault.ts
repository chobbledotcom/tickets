import { execute } from "#db/client.ts";
import { type SqlStatement, sql, sqlLiteral, sqlName } from "#db/sql.ts";

/**
 * Run `body` with one database fault installed — a trigger that makes a
 * chosen write fail at SQLite's own boundary — then lift the fault. Real
 * faults at the storage layer, not stubs: the failing statement rolls back
 * exactly as a production write would.
 */
export const withDbFault = async <T>(
  createTrigger: SqlStatement,
  name: string,
  body: () => Promise<T>,
): Promise<T> => {
  await execute(createTrigger);
  try {
    return await body();
  } finally {
    await execute(sql`DROP TRIGGER IF EXISTS ${sqlName(name)}`);
  }
};

/** A fault that makes one chosen write refuse: the trigger `name`, placed on
 * `event`, raises `message`. The `when` clause narrows the write. */
const refusedWriteFault =
  (
    name: string,
    event: SqlStatement,
    message: string,
    when: SqlStatement = sql``,
  ) =>
  <T>(body: () => Promise<T>): Promise<T> =>
    withDbFault(
      sql`CREATE TRIGGER ${sqlName(name)}
      BEFORE ${event}
      ${when}
      BEGIN
        SELECT RAISE(ABORT, ${sqlLiteral(message)});
      END`,
      name,
      body,
    );

/** The authority retirement — the update that marks a completed refund's
 * local recording done — refuses, and every other write stays available. */
export const withAuthorityRetirementFault = refusedWriteFault(
  "test_authority_retirement_fault",
  sql`UPDATE ON payment_charges`,
  "authority retirement unavailable",
  sql`WHEN NEW.refund_local_state = 'recorded'`,
);

/** The write that records a session's terminal failure refuses, so a test
 * can die exactly between a refund going out and the answer landing. */
export const withSessionFailureFault = refusedWriteFault(
  "test_session_failure_fault",
  sql`UPDATE OF failure_data ON processed_payments`,
  "session failure write refused",
  sql`WHEN NEW.failure_data != ''`,
);

/** The once-only confirmation latch refuses, so the note and activity line
 * that ride its transaction never land on this run. */
export const withRefundConfirmationFault = refusedWriteFault(
  "test_refund_confirmation_fault",
  sql`INSERT ON refund_confirmations`,
  "refund confirmation unavailable",
);

const CONCURRENT_DOOR_DRAIN = "test_concurrent_door_drain";

/** One place at the named booking line checks in the moment a queued
 * delivery's pair is reserved — the write another door commits between
 * the scan's decision and its admission, inside the delivery's own
 * transaction. The admission then caps at what the line still owes. */
export const withConcurrentDoorDrain = <T>(
  attendeeId: number,
  listingId: number,
  body: () => Promise<T>,
): Promise<T> =>
  withDbFault(
    sql`CREATE TRIGGER ${sqlName(CONCURRENT_DOOR_DRAIN)}
      AFTER INSERT ON processed_scan_operations
      BEGIN
        UPDATE listing_attendees
        SET checked_in = checked_in + 1
        WHERE attendee_id = ${sqlLiteral(attendeeId)}
          AND listing_id = ${sqlLiteral(listingId)}
          AND checked_in < quantity;
      END`,
    CONCURRENT_DOOR_DRAIN,
    body,
  );

/** Point one attendee's booking at a listing that no longer resolves, so a
 * token scan of it finds the attendee but no listing to name for the line. */
export const orphanAttendeeBooking = async (token: string): Promise<void> => {
  const { getDb } = await import("#db/client.ts");
  const { hmacHash } = await import("#crypto/hashing.ts");
  // The hashed index first, so an early failure never touches the
  // foreign-key switch; the try/finally restores it whatever the update
  // does to a connection later suites share.
  const tokenIndex = await hmacHash(token);
  const db = getDb();
  await db.execute(sql`PRAGMA foreign_keys = OFF`);
  try {
    await db.execute(sql`UPDATE listing_attendees
            SET listing_id = 99999
            WHERE attendee_id = (
              SELECT id FROM attendees WHERE ticket_token_index = ${tokenIndex}
            )`);
  } finally {
    await db.execute(sql`PRAGMA foreign_keys = ON`);
  }
};
