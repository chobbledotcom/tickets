/**
 * Repoint an attendee's ledger rows onto another attendee id — the one
 * sanctioned mutation of stored account ids (the ledger is append-only
 * everywhere else). Used by attendee merge: the source's legs move wholesale
 * onto the target so the financial history follows the person and nothing
 * strands on the deleted source (plan §5.17).
 *
 * Returns statements for the merge's own batch, so the repoint commits or rolls
 * back atomically with the rest of the merge. A pre-ledger source matches no
 * rows, so the updates are a harmless no-op.
 */

import { attendeeAccount } from "#accounting/accounts.ts";
import { type SqlStatement, update } from "#db/client.ts";

export const repointAttendeeStatements = (
  fromAttendeeId: number,
  toAttendeeId: number,
): SqlStatement[] => {
  const from = attendeeAccount(fromAttendeeId);
  const to = attendeeAccount(toAttendeeId);
  return [
    update(
      "transfers",
      { source_id: to.id },
      { source_id: from.id, source_type: from.type },
    ),
    update(
      "transfers",
      { dest_id: to.id },
      { dest_id: from.id, dest_type: from.type },
    ),
  ];
};
