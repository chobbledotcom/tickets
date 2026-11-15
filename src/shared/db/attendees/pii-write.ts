/** One atomic attendee PII save. */

import type { UpdateAttendeePIIInput } from "#db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#db/attendees/pii.ts";

import { settings } from "#db/settings.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

export const attendeePiiWriteStatements = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
): Promise<SqlStatement[]> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob(pii),
    settings.publicKey,
  );
  return [
    sql`UPDATE attendees SET pii_blob = ${encryptedPiiBlob} WHERE id = ${attendeeId}`,
  ];
};
