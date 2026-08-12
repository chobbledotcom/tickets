/** One atomic attendee PII save, including any old payment identity it reveals. */

import type { UpdateAttendeePIIInput } from "#shared/db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { attendeePaymentAnchorStatements } from "#shared/db/payment-anchor/attendee.ts";
import { settings } from "#shared/db/settings.ts";

/** Build the inseparable PII update and legacy-payment materialization. */
export const attendeePiiWriteStatements = async (
  attendeeId: number,
  pii: UpdateAttendeePIIInput,
): Promise<SqlStatement[]> => {
  const paymentAnchors = await attendeePaymentAnchorStatements(
    attendeeId,
    pii.payment_id,
  );
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob(pii),
    settings.publicKey,
  );
  return [
    {
      args: [encryptedPiiBlob, attendeeId],
      sql: "UPDATE attendees SET pii_blob = ? WHERE id = ?",
    },
    ...paymentAnchors,
  ];
};
