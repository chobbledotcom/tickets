/** One atomic attendee PII save. */

import type { UpdateAttendeePIIInput } from "#db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#db/attendees/pii.ts";

import { tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import type { SqlStatement } from "#db/sql.ts";
import { update } from "#db/write.ts";

export const attendeePiiWriteStatements = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
): Promise<SqlStatement[]> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob(pii),
    settings.publicKey,
  );
  return [
    update(tables.attendees, { pii_blob: encryptedPiiBlob }).where({
      id: attendeeId,
    }),
  ];
};
