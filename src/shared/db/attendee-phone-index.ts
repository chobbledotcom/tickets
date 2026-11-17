/**
 * Attendee phone blind-index reads/writes (see #shared/sms/phone-index.ts).
 */

import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import { execute, queryOne } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
import { update } from "#db/write.ts";

/**
 * Store the phone blind-index on an attendee, but only if one is not set yet.
 * Idempotent: re-texting the same attendee will not overwrite it.
 */
export const setAttendeePhoneIndexIfEmpty = async (
  attendeeId: number,
  phoneIndex: string,
): Promise<void> => {
  if (!phoneIndex) return;
  // The `phone_index: ""` condition scopes the write to a not-yet-set row.
  await execute(
    update(tables.attendees, { phoneIndex }).where({
      id: attendeeId,
      phoneIndex: "",
    }),
  );
};

/** Find the attendee id whose phone blind-index matches, if any. */
export const findAttendeeIdByPhoneIndex = async (
  phoneIndex: string,
): Promise<number | null> => {
  if (!phoneIndex) return null;
  const row = await queryOne<{ id: number }>(
    sql`SELECT id FROM attendees
     WHERE phone_index = ${phoneIndex} AND kind = ${sqlLiteral(ATTENDEE_KIND)}
     LIMIT 1`,
  );
  return row?.id ?? null;
};
