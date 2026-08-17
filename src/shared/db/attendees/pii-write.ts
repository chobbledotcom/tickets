/** One atomic attendee PII save. */

import type { UpdateAttendeePIIInput } from "#shared/db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";

export const attendeePiiWriteStatements = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
): Promise<SqlStatement[]> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob(pii),
    settings.publicKey,
  );
  return [
    {
      args: [encryptedPiiBlob, attendeeId],
      sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
    },
  ];
};
