/**
 * Repoint an attendee's ledger rows onto another attendee id — the one
 * sanctioned mutation of stored account ids (the ledger is append-only
 * everywhere else). Used by attendee merge. The source's legs move wholesale
 * onto the target, so the financial history follows the person and nothing
 * strands on the deleted source (plan §5.17).
 *
 * Returns statements for the merge's own batch, so the repoint commits or rolls
 * back atomically with the rest of the merge. A pre-ledger source matches no
 * rows, so the updates are a harmless no-op.
 */

import { attendeeAccount } from "#accounting/accounts.ts";
import { tables } from "#db/select/tables.ts";
import type { SqlStatement } from "#db/sql.ts";
import { update } from "#db/write.ts";

export const repointAttendeeStatements = (
  fromAttendeeId: number,
  toAttendeeId: number,
): SqlStatement[] => {
  const from = attendeeAccount(fromAttendeeId);
  const to = attendeeAccount(toAttendeeId);
  return [
    update(tables.transfers, { sourceId: to.id }).where({
      sourceId: from.id,
      sourceType: from.type,
    }),
    update(tables.transfers, { destId: to.id }).where({
      destId: from.id,
      destType: from.type,
    }),
    update(tables.booking_tax_assessments, {
      attendeeId: toAttendeeId,
    }).where({ attendeeId: fromAttendeeId }),
  ];
};
