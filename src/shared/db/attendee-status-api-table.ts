/** The CRUD table the admin JSON API writes through. It lives apart from
 *  attendee-statuses.ts, which stays under its length limit. */

/* jscpd:ignore-start -- import block */
import type { InValue } from "@libsql/client";
import {
  type AttendeeStatus,
  type AttendeeStatusWriteInput,
  attendeeStatusDeleteMessage,
  attendeeStatuses,
  attendeeStatusSaveMessage,
  attendeeStatusWrites,
} from "#db/attendee-statuses.ts";
import type { Table } from "#db/table.ts";
import { TransactionValidationError } from "#db/transaction.ts";

/* jscpd:ignore-end */

/** Save a status through the boundary, throwing the operator-facing message
 *  as a validation error when the boundary refuses. */
const attendeeStatusSaveOrThrow = async (
  id: number | null,
  input: AttendeeStatusWriteInput,
): Promise<AttendeeStatus> => {
  const result = await attendeeStatusWrites.save(id, input);
  if (!result.ok) {
    throw new TransactionValidationError(
      attendeeStatusSaveMessage(result.error),
    );
  }
  return result.value;
};

/** Delete a status through the boundary, throwing the operator-facing message
 *  as a validation error when the boundary refuses. */
const attendeeStatusDeleteOrThrow = async (id: number): Promise<void> => {
  const result = await attendeeStatusWrites.delete(id);
  if (!result.ok) {
    throw new TransactionValidationError(
      attendeeStatusDeleteMessage(result.error),
    );
  }
};

/** One full status write input from a partial one: every field the update
 *  leaves out falls back to its stored-column default. The API mappers always
 *  send the full input, so the name guard is the only part a direct caller
 *  can reach. */
const toFullStatusWrite = (
  input: Partial<AttendeeStatusWriteInput> & { name: string },
): AttendeeStatusWriteInput => ({
  isPaidDefault: input.isPaidDefault ?? false,
  isPublicDefault: input.isPublicDefault ?? false,
  isReservation: input.isReservation ?? false,
  name: input.name,
  reservationAmount: input.reservationAmount ?? "0",
});

/** The CRUD write surface the admin JSON API writes through. The raw table's
 *  reads (already decrypted names) carry over. The three writes go through
 *  the shared attendeeStatusWrites boundary, so the single-default
 *  invariants hold. A refused write throws the message the factory turns
 *  into a 400. The transactional statement builders stay absent: this
 *  surface never takes the join-write path. */
export const attendeeStatusApiTable: Table<
  AttendeeStatus,
  AttendeeStatusWriteInput
> = {
  columns: attendeeStatuses.table.columns,
  deleteById: (id: InValue) => attendeeStatusDeleteOrThrow(Number(id)),
  findByIdPrimary: (id: InValue) => attendeeStatuses.table.findByIdPrimary!(id),
  fromDb: attendeeStatuses.table.fromDb,
  inputKeyMap: attendeeStatuses.table.inputKeyMap,
  insert: (input: AttendeeStatusWriteInput) =>
    attendeeStatusSaveOrThrow(null, input),
  name: attendeeStatuses.table.name,
  primaryKey: attendeeStatuses.table.primaryKey,
  read: attendeeStatuses.table.read,
  readColumn: attendeeStatuses.table.readColumn,
  rowToInput: attendeeStatuses.table.rowToInput,
  schema: attendeeStatuses.table.schema,
  toDbValues: attendeeStatuses.table.toDbValues,
  update: async (id: InValue, input: Partial<AttendeeStatusWriteInput>) => {
    // The API mappers always send the name. A direct partial call that omits
    // it is a bug, so it fails loudly instead of storing an empty name.
    const name = input.name;
    if (name === undefined) {
      throw new Error("attendeeStatusApiTable.update requires the name field");
    }
    return attendeeStatusSaveOrThrow(
      Number(id),
      toFullStatusWrite({ ...input, name }),
    );
  },
};
