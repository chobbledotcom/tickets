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

import type { InValue } from "@libsql/client";
import { attendeeAccount } from "#shared/accounting/accounts.ts";

export const repointAttendeeStatements = (
  fromAttendeeId: number,
  toAttendeeId: number,
): { args: InValue[]; sql: string }[] => {
  const from = attendeeAccount(fromAttendeeId);
  const to = attendeeAccount(toAttendeeId);
  return [
    {
      args: [to.id, from.type, from.id],
      sql: "UPDATE transfers SET source_id = ? WHERE source_type = ? AND source_id = ?",
    },
    {
      args: [to.id, from.type, from.id],
      sql: "UPDATE transfers SET dest_id = ? WHERE dest_type = ? AND dest_id = ?",
    },
  ];
};
