/**
 * Attendee phone blind-index reads/writes (see #shared/sms/phone-index.ts).
 */

import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { execute, queryOne } from "#shared/db/client.ts";

/**
 * Store the phone blind-index on an attendee, but only if one isn't set yet.
 * Idempotent: re-texting the same attendee won't overwrite it.
 */
export const setAttendeePhoneIndexIfEmpty = async (
  attendeeId: number,
  phoneIndex: string,
): Promise<void> => {
  if (!phoneIndex) return;
  await execute(
    "UPDATE attendees SET phone_index = ? WHERE id = ? AND phone_index = ''",
    [phoneIndex, attendeeId],
  );
};

/** Find the attendee id whose phone blind-index matches, if any. */
export const findAttendeeIdByPhoneIndex = async (
  phoneIndex: string,
): Promise<number | null> => {
  if (!phoneIndex) return null;
  const row = await queryOne<{ id: number }>(
    `SELECT id FROM attendees
     WHERE phone_index = ? AND kind = '${ATTENDEE_KIND}'
     LIMIT 1`,
    [phoneIndex],
  );
  return row?.id ?? null;
};
