/**
 * Attendee statuses table operations.
 *
 * Statuses are owner-defined labels an attendee moves through (e.g. a public
 * reservation that later becomes paid). The flags and the reservation amount
 * are stored as plaintext so the public balance-payment page and the payment
 * webhook can reason about reserved/paid state without the private key — only
 * the human-readable `name` is encrypted at rest.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  execute,
  queryAll,
  resultRows,
  type SqlStatement,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import type { NamedSortOrderInput } from "#shared/db/common-schema.ts";
import { defineOrderedCollection } from "#shared/db/ordered-collection.ts";
import { col, defineCachedListTable, writeTableRow } from "#shared/db/table.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** Name of the status seeded on first run so there is always at least one. */
export const DEFAULT_ATTENDEE_STATUS_NAME = "Confirmed";

/** A status an attendee can be in. */
export interface AttendeeStatus {
  id: number;
  is_paid_default: boolean;
  is_public_default: boolean;
  is_reservation: boolean;
  name: string; // encrypted at rest
  reservation_amount: string;
  sort_order: number;
}

/** Complete owner form input for creating or editing a status. */
export interface AttendeeStatusWriteInput {
  isPaidDefault: boolean;
  isPublicDefault: boolean;
  isReservation: boolean;
  name: string;
  reservationAmount: string;
}

export type AttendeeStatusSaveError =
  | "public_default_required"
  | "paid_default_required";

export type AttendeeStatusDeleteError =
  | "last_status"
  | "public_default"
  | "paid_default"
  | "status_in_use";

/** Cached attendee_statuses table — only `name` is encrypted; writes
 * auto-invalidate the cache. */
export const attendeeStatuses = defineCachedListTable<
  AttendeeStatus,
  NamedSortOrderInput & Partial<AttendeeStatusWriteInput>
>({
  name: "attendee_statuses",
  orderBy: "sort_order ASC, id ASC",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    is_paid_default: col.boolean(false),
    is_public_default: col.boolean(false),
    is_reservation: col.boolean(false),
    name: col.encrypted(encrypt, decrypt),
    reservation_amount: col.simple<string>(),
    sort_order: col.simple<number>(),
  },
});

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
export const requirePublicDefaultStatus = getFlaggedStatus("is_public_default");

/** The status an attendee moves to once a reservation balance is paid. */
export const requirePaidDefaultStatus = getFlaggedStatus("is_paid_default");

/** The id of the public-default status. */
export const requirePublicStatusId = async (): Promise<number> =>
  (await requirePublicDefaultStatus()).id;

type DefaultRow = {
  is_paid_default: number;
  is_public_default: number;
  sort_order: number;
};

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
  const current = resultRows<DefaultRow>(
    await tx.execute({
      args: [id],
      sql: `SELECT status.is_public_default, status.is_paid_default, status.sort_order
              FROM attendee_statuses AS status
             WHERE status.id = ?`,
    }),
  )[0];
  if (!current) throw new Error(`Attendee status ${id} does not exist`);
  return current;
};

const defaultChangeError = (
  current: DefaultRow,
  input: AttendeeStatusWriteInput,
): AttendeeStatusSaveError | null => {
  if (current.is_public_default === 1 && !input.isPublicDefault) {
    return "public_default_required";
  }
  return current.is_paid_default === 1 && !input.isPaidDefault
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
    await executeStatusWrite(tx, {
      args: [id, id],
      sql: `UPDATE attendee_statuses AS status
               SET ${column} = 0
             WHERE (? IS NULL OR status.id != ?) AND status.${column} = 1`,
    });
  };
  if (input.isPublicDefault) {
    await clearDefault("is_public_default");
  }
  if (input.isPaidDefault) {
    await clearDefault("is_paid_default");
  }
};

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
      await writeTableRow(tx, attendeeStatuses.table, {
        id,
        input,
        kind: "update",
      });
      return okResult({
        id,
        is_paid_default: input.isPaidDefault,
        is_public_default: input.isPublicDefault,
        is_reservation: input.isReservation,
        name: input.name,
        reservation_amount: input.reservationAmount,
        sort_order: current.sort_order,
      });
    }

    await clearChosenDefaults(tx, null, input);
    const sortOrder = await attendeeStatusOrder.next({ transaction: tx });
    const status = await writeTableRow(tx, attendeeStatuses.table, {
      input: { ...input, sortOrder },
      kind: "insert",
    });
    return okResult(status);
  });

const deleteStatus = (
  id: number,
): Promise<Result<void, AttendeeStatusDeleteError>> =>
  withTransaction(async (tx) => {
    const status = await getCurrentDefaults(tx, id);

    const anotherStatus = await tx.execute({
      args: [id],
      sql: `SELECT status.id
              FROM attendee_statuses AS status
             WHERE status.id != ?
             LIMIT 1`,
    });
    if (anotherStatus.rows.length === 0) return errorResult("last_status");
    if (status.is_public_default === 1) {
      return errorResult("public_default");
    }
    if (status.is_paid_default === 1) return errorResult("paid_default");

    const attendee = await tx.execute({
      args: [id],
      sql: `SELECT attendee.id
              FROM attendees AS attendee
             WHERE attendee.status_id = ?
             LIMIT 1`,
    });
    if (attendee.rows.length > 0) return errorResult("status_in_use");

    await tx.execute({
      args: [id],
      sql: "DELETE FROM attendee_statuses AS status WHERE status.id = ?",
    });
    return okResult(undefined);
  });

export interface AttendeeStatusWrites {
  delete: (id: number) => Promise<Result<void, AttendeeStatusDeleteError>>;
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
  const existing = await queryAll<{ id: number }>(
    "SELECT status.id FROM attendee_statuses AS status LIMIT 1",
  );
  if (existing.length > 0) return;
  const status = await attendeeStatuses.table.insert({
    isPaidDefault: true,
    isPublicDefault: true,
    isReservation: false,
    name: DEFAULT_ATTENDEE_STATUS_NAME,
    reservationAmount: "0",
    sortOrder: 0,
  });
  await execute(
    "UPDATE attendees AS attendee SET status_id = ? WHERE attendee.status_id IS NULL",
    [status.id],
  );
};
