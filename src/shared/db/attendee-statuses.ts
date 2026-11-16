/**
 * Attendee statuses table operations.
 *
 * Statuses are owner-defined labels an attendee moves through (e.g. a public
 * reservation that later becomes paid). The flags and the reservation amount
 * are stored as plaintext so the public balance-payment page and the payment
 * webhook can read the reserved/paid state. Only the human-readable `name` is
 * encrypted at rest.
 */

import { logActivity } from "#db/activity-log.ts";
import {
  execute,
  queryAll,
  resultRows,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { defineOrderedCollection } from "#db/ordered-collection.ts";
import { readRows } from "#db/read.ts";
import {
  insertRow,
  insertRowStatement,
  type NewRecord,
  rowValuesOf,
  updateRowStatement,
} from "#db/record-table.ts";
import { among, equal, notEqual } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { CountRow } from "#db/select/shape.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { type RowsStatement, type SqlStatement, sql } from "#db/sql.ts";
import { tableCache } from "#db/table-cache.ts";
import { deleteFrom, update } from "#db/write.ts";
import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import type { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { requestCache } from "#shared/request-cache.ts";
import { requireValue } from "#shared/required-value.ts";
import type { FieldsInput } from "#shared/rest/field-specs.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** Name of the status seeded on first run so there is always at least one. */
export const DEFAULT_ATTENDEE_STATUS_NAME = "Confirmed";

/** A status an attendee can be in: its declared fields and its place in
 *  the list. */
export type AttendeeStatus = DecodedRowOf<"attendee_statuses">;

/** Complete owner form input for creating or editing a status. */
export type AttendeeStatusWriteInput = FieldsInput<typeof STATUS_FIELDS>;

export type AttendeeStatusSaveError =
  | "public_default_required"
  | "paid_default_required";

export type AttendeeStatusDeleteError =
  | "last_status"
  | "public_default"
  | "paid_default"
  | "status_in_use";

/** The message a refused status save answers with, per the error code. Shared
 *  by the dashboard form and the admin JSON API, so an API caller reads the
 *  same refusal an operator reads on the settings page. */
export const attendeeStatusSaveMessage = (
  code: AttendeeStatusSaveError,
): string => {
  switch (code) {
    case "paid_default_required":
      return "Choose another paid default before clearing this one";
    case "public_default_required":
      return "Choose another public default before clearing this one";
  }
};

/** The message a refused status delete answers with, per the error code. The
 *  catalog-backed message reads its translation at call time, because this db
 *  module loads before the message groups. */
export const attendeeStatusDeleteMessage = (
  code: AttendeeStatusDeleteError,
): string => {
  switch (code) {
    case "last_status":
      return "You must keep at least one status";
    case "paid_default":
      return "Choose another paid default before deleting this status";
    case "public_default":
      return "Choose another public default before deleting this status";
    case "status_in_use":
      return t("statuses.delete_in_use_no_target");
  }
};

/** The prerequisite the delete command refuses on before any reassign:
 *  the one home of the order both the save and the delete page ask. */
export type StatusDeleteBlocker = Exclude<
  AttendeeStatusDeleteError,
  "status_in_use"
>;

/** The prerequisite a delete of this status would be refused on, or null when
 *  the delete can proceed (freely, or through a reassign choice). The delete
 *  command refuses in exactly this order. The delete page predicts it. */
export const statusDeleteBlocker = (
  status: Pick<AttendeeStatus, "is_paid_default" | "is_public_default">,
  anotherStatusExists: boolean,
): StatusDeleteBlocker | null => {
  if (!anotherStatusExists) return "last_status";
  if (status.is_public_default) return "public_default";
  if (status.is_paid_default) return "paid_default";
  return null;
};

/** The other statuses and the blocker a delete of this status will be
 *  refused on. The blocker is null when the delete can proceed. The delete
 *  page and the JSON API both ask this before a delete, so they refuse
 *  exactly the same statuses. Both callers have already loaded the status, so
 *  a missing row is a broken race and throws loudly. */
export const statusDeleteProspects = async (
  id: number,
): Promise<{
  blocker: StatusDeleteBlocker | null;
  others: readonly AttendeeStatus[];
}> => {
  const status = requireValue(
    await getAttendeeStatus(id),
    `Attendee status ${id} does not exist`,
  );
  const others = (await attendeeStatuses.getAll()).filter(
    (other) => other.id !== id,
  );
  return { blocker: statusDeleteBlocker(status, others.length > 0), others };
};

/** Every status in its list order, cached for the request. Only `name` is
 * encrypted, and its codec decrypts it. */
export const attendeeStatuses = tableCache(
  tables.attendee_statuses,
  requestCache(() =>
    readRows(
      from(tables.attendee_statuses).sortedBy("sort_order", "id").everyColumn(),
    ),
  ),
);

export const attendeeStatusOrder = defineOrderedCollection({
  key: "id",
  table: "attendee_statuses",
});

/** Find the first cached status matching a predicate (decrypted), or null. */
const findStatus = async (
  pred: (s: AttendeeStatus) => boolean,
): Promise<AttendeeStatus | null> => {
  const all = await attendeeStatuses.getAll();
  const found = all.find(pred);
  return found === undefined ? null : found;
};

/** Get a single status by id (decrypted), or null. */
export const getAttendeeStatus = (id: number): Promise<AttendeeStatus | null> =>
  findStatus((s) => s.id === id);

/** Get the status carrying a required default flag. */
const getFlaggedStatus =
  (flag: "is_public_default" | "is_paid_default") =>
  async (): Promise<AttendeeStatus> =>
    requireValue(
      await findStatus((item) => item[flag]),
      `No attendee status has the required ${flag} flag`,
    );

/** The status new public bookings start in. */
export const requirePublicDefaultStatus: () => Promise<AttendeeStatus> =
  getFlaggedStatus("is_public_default");

/** The status an attendee moves to once a reservation balance is paid. */
export const requirePaidDefaultStatus: () => Promise<AttendeeStatus> =
  getFlaggedStatus("is_paid_default");

/** The id of the public-default status. */
export const requirePublicStatusId = async (): Promise<number> =>
  (await requirePublicDefaultStatus()).id;

/** The status new bookings start in, read from a status list the caller has
 *  already loaded. Both attendee create paths resolve a missing choice to it —
 *  the admin form and the admin JSON API — so the rule lives beside the save
 *  and delete guards that keep one status carrying the flag. A list without a
 *  public default is a broken setup and fails loudly; the seed and the write
 *  guards make that state unreachable. */
export const publicDefaultStatusOf = (
  statuses: readonly AttendeeStatus[],
): AttendeeStatus =>
  requireValue(
    statuses.find((status) => status.is_public_default),
    "No public default status is configured",
  );

/** The three columns a status write reads back about itself. Their codecs
 * give the two default flags as booleans, not as the 1/0 that is stored. */
const statusDefaults = (id: number) =>
  from(tables.attendee_statuses)
    .where({ id })
    .pick("is_paid_default", "is_public_default", "sort_order");

type DefaultRow = Pick<
  AttendeeStatus,
  "is_paid_default" | "is_public_default" | "sort_order"
>;

const executeStatusWrite = async (
  tx: TxScope,
  statement: SqlStatement,
): Promise<void> => {
  await tx.execute(statement);
};

const getCurrentDefaults = async (
  tx: TxScope,
  id: number,
): Promise<DefaultRow> => {
  const [current] = resultRows(await tx.execute(statusDefaults(id)));
  if (!current) throw new Error(`Attendee status ${id} does not exist`);
  return current;
};

const defaultChangeError = (
  current: DefaultRow,
  input: AttendeeStatusWriteInput,
): AttendeeStatusSaveError | null => {
  if (current.is_public_default && !input.isPublicDefault) {
    return "public_default_required";
  }
  return current.is_paid_default && !input.isPaidDefault
    ? "paid_default_required"
    : null;
};

const clearChosenDefaults = async (
  tx: TxScope,
  id: number | null,
  input: AttendeeStatusWriteInput,
): Promise<void> => {
  const clearDefault = async (
    column: "is_public_default" | "is_paid_default",
  ): Promise<void> => {
    await executeStatusWrite(
      tx,
      update(tables.attendee_statuses, { [column]: 0 }).where((status) => [
        id === null ? true : notEqual(status.id, id),
        equal(status[column], 1),
      ]),
    );
  };
  if (input.isPublicDefault) {
    await clearDefault("is_public_default");
  }
  if (input.isPaidDefault) {
    await clearDefault("is_paid_default");
  }
};

/** The status row that a write gives back. */
const writtenStatus = async (
  tx: TxScope,
  write: RowsStatement<AttendeeStatus>,
): Promise<AttendeeStatus> =>
  requireValue(
    resultRows(await tx.execute(write))[0],
    "The status write gave back no row",
  );

const saveStatus = (
  id: number | null,
  input: AttendeeStatusWriteInput,
): Promise<Result<AttendeeStatus, AttendeeStatusSaveError>> =>
  withTransaction(async (tx) => {
    if (id !== null) {
      const current = await getCurrentDefaults(tx, id);
      const error = defaultChangeError(current, input);
      if (error !== null) return errorResult(error);
      await clearChosenDefaults(tx, id, input);
      return okResult(
        await writtenStatus(
          tx,
          await updateRowStatement(
            tables.attendee_statuses,
            id,
            rowValuesOf(tables.attendee_statuses, input),
          ),
        ),
      );
    }

    await clearChosenDefaults(tx, null, input);
    const sortOrder = await attendeeStatusOrder.next({ transaction: tx });
    return okResult(
      await writtenStatus(
        tx,
        await insertRowStatement(tables.attendee_statuses, {
          // The status rule checked that the input names every field.
          ...(rowValuesOf(
            tables.attendee_statuses,
            input,
          ) as NewRecord<"attendee_statuses">),
          sort_order: sortOrder,
        }),
      ),
    );
  });

/** Reads the two statuses a reassign touches — the row being emptied and the
 *  owner's chosen target — with their decoded names, in one query. Fewer than
 *  two distinct rows means the target is missing. */
const reassignNameRows = async (
  tx: TxScope,
  fromId: number,
  toId: number,
): Promise<{ fromName: string; toName: string } | null> => {
  const rows = resultRows(
    await tx.execute(
      from(tables.attendee_statuses)
        .where((status) => among(status.id, [fromId, toId]))
        .pick("id", "name"),
    ),
  );
  if (rows.length !== 2) return null;
  const named = new Map(rows.map((row) => [row.id, row.name] as const));
  return {
    fromName: requiredMapValue(
      named,
      fromId,
      `Attendee status ${fromId} missing`,
    ),
    toName: requiredMapValue(named, toId, `Attendee status ${toId} missing`),
  };
};

/** The one occupancy query, read two ways: through a write transaction (the
 *  delete command's probe) and through the plain client (the delete page's
 *  displayed count). One query, so the two can never disagree on what holds. */
const heldCountThrough = async (
  readRows: (statement: SqlStatement) => Promise<CountRow[]>,
  statusId: number,
): Promise<number> => {
  const rows = await readRows(
    from(tables.attendees).where({ status_id: statusId }).count(),
  );
  return Number(rows[0]!.count);
};

/** How many attendees sit on a status, read inside a transaction. */
const heldAttendeeCountTx = (tx: TxScope, id: number): Promise<number> =>
  heldCountThrough((statement) => txRows(tx, statement), id);

/** How many attendees sit on a status, read outside a transaction. */
export const heldAttendeeCount = (id: number): Promise<number> =>
  heldCountThrough(queryAll, id);

/** Reads rows through an open write transaction, naming the rows. */
const txRows = async <T>(tx: TxScope, stmt: SqlStatement): Promise<T[]> =>
  resultRows<T>(await tx.execute(stmt));

/** Moves every attendee off `id` onto the operator's chosen `reassignTo`
 *  status, inside the caller's transaction, and records the move. Returns the
 *  moved count, or null when attendees hold the status and the target is
 *  missing or the status itself. */
const reassignHeldAttendees = async (
  tx: TxScope,
  id: number,
  reassignTo: number | undefined,
): Promise<number | null> => {
  const held = await heldAttendeeCountTx(tx, id);
  if (held === 0) return 0;
  if (reassignTo === undefined || reassignTo === id) return null;
  const names = await reassignNameRows(tx, id, reassignTo);
  if (names === null) return null;
  await tx.execute(
    update(tables.attendees, { status_id: reassignTo }).where({
      status_id: id,
    }),
  );
  await logActivity(
    `${held} attendee(s) moved from status '${names.fromName}' to '${names.toName}'`,
    null,
    null,
    tx,
  );
  return held;
};

/** The single delete command for a status row. A status attendees hold needs
 *  the operator's chosen target: every held attendee moves to it inside the
 *  transaction, then the status goes. A missing target keeps everything. */
const deleteStatus = (
  id: number,
  reassignTo?: number,
): Promise<Result<void, AttendeeStatusDeleteError>> =>
  withTransaction(async (tx) => {
    const status = await getCurrentDefaults(tx, id);

    const [anotherStatus] = await txRows<{ id: number }>(
      tx,
      sql`SELECT status.id
              FROM attendee_statuses AS status
             WHERE status.id != ${id}
             LIMIT 1`,
    );
    const blocker = statusDeleteBlocker(status, anotherStatus !== undefined);
    if (blocker) return errorResult(blocker);

    if ((await reassignHeldAttendees(tx, id, reassignTo)) === null) {
      return errorResult("status_in_use");
    }

    await tx.execute(deleteFrom(tables.attendee_statuses).where({ id }));
    return okResult(undefined);
  });

export interface AttendeeStatusWrites {
  delete: (
    id: number,
    reassignTo?: number,
  ) => Promise<Result<void, AttendeeStatusDeleteError>>;
  save: (
    id: number | null,
    input: AttendeeStatusWriteInput,
  ) => Promise<Result<AttendeeStatus, AttendeeStatusSaveError>>;
}

/** The single owner-write boundary for status rows and their invariants. */
export const attendeeStatusWrites: AttendeeStatusWrites = {
  delete: deleteStatus,
  save: saveStatus,
};

/**
 * Ensure at least one status exists. Seeds a single non-reservation default
 * (both the public-new and paid target) so fresh installs behave exactly as
 * before — public bookings are paid in full with no balance — and backfills
 * any pre-existing attendees onto it. Idempotent: a no-op once any status
 * exists. Runs from the schema migration so every environment is seeded.
 */
export const ensureDefaultAttendeeStatus = async (): Promise<void> => {
  const existing = await queryAll(
    from(tables.attendee_statuses).limit(1).pick("id"),
  );
  if (existing.length > 0) return;
  const status = await insertRow(tables.attendee_statuses, {
    is_paid_default: true,
    is_public_default: true,
    is_reservation: false,
    name: DEFAULT_ATTENDEE_STATUS_NAME,
    reservation_amount: "0",
    sort_order: 0,
  });
  await execute(
    update(tables.attendees, { status_id: status.id }).where({
      status_id: null,
    }),
  );
};
