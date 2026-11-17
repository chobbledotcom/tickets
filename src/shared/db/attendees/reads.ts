// effects: pure
/**
 * Reads of the attendees table that more than one module needs.
 */

import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";

/** The id of the attendee that a ticket token index names. The table goes by
 *  its own word, so a read of attendees can hold this read. */
export const attendeeIdOfToken = (tokenIndex: string) =>
  from(tables.attendees)
    .as("tokenHolder")
    .where({ ticketTokenIndex: tokenIndex })
    .pick("id");

/** The id and the sealed contact details of each of these attendees. */
export const sealedContactsOf = (attendeeIds: readonly number[]) =>
  from(tables.attendees).where({ id: attendeeIds }).pick("id", "piiBlob");
