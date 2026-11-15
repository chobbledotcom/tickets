/**
 * Atomic attendee creation for fixtures that need the row to exist. A refused
 * create throws where the data is seeded and names its reason, so a mis-wired
 * test fails at the fixture instead of asserting against a row that never
 * landed.
 */

import type { AttendeeInput } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import type { Attendee } from "#types";

/** Create one attendee and return it; a refused create throws. */
export const createAttendeeOrThrow = async (
  input: AttendeeInput,
): Promise<Attendee> => {
  const created = await attendeesApi.createAttendeeAtomic(input);
  if (!created.success) throw new Error(`create refused: ${created.reason}`);
  return created.attendees[0]!;
};
