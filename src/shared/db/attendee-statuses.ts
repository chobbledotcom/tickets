/**
 * Attendee statuses table operations.
 *
 * Statuses are owner-defined labels an attendee moves through (e.g. a public
 * reservation that later becomes paid). The flags and the reservation amount
 * are stored as plaintext so the public balance-payment page and the payment
 * webhook can reason about reserved/paid state without the private key — only
 * the human-readable `name` is encrypted at rest.
 */

import { registerCache } from "#shared/cache-registry.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { executeBatch, getDb, queryAll } from "#shared/db/client.ts";
import { queryAndMap, swapSortOrder } from "#shared/db/query.ts";
import { col, defineTable, withCacheInvalidation } from "#shared/db/table.ts";
import { requestCache } from "#shared/request-cache.ts";

/** Name of the status seeded on first run so there is always at least one. */
export const DEFAULT_ATTENDEE_STATUS_NAME = "Confirmed";

/** A status an attendee can be in. */
export interface AttendeeStatus {
  id: number;
  sort_order: number;
  name: string; // encrypted at rest
  is_public_default: boolean;
  is_paid_default: boolean;
  is_reservation: boolean;
  reservation_amount: string;
}

/** Create/update input (camelCase). */
export type AttendeeStatusInput = {
  name: string;
  sortOrder?: number;
  isPublicDefault?: boolean;
  isPaidDefault?: boolean;
  isReservation?: boolean;
  reservationAmount?: string;
};

const rawAttendeeStatusesTable = defineTable<
  AttendeeStatus,
  AttendeeStatusInput
>({
  name: "attendee_statuses",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    is_paid_default: col.boolean(false),
    is_public_default: col.boolean(false),
    is_reservation: col.boolean(false),
    name: col.encrypted<string>(encrypt, decrypt),
    reservation_amount: col.simple<string>(),
    sort_order: col.simple<number>(),
  },
});

/** Execute a query and decrypt the resulting status rows. */
const queryStatuses = queryAndMap<AttendeeStatus, AttendeeStatus>((row) =>
  rawAttendeeStatusesTable.fromDb(row),
);

const statusesCache = requestCache(() =>
  queryStatuses(
    "SELECT * FROM attendee_statuses ORDER BY sort_order ASC, id ASC",
  ),
);

registerCache(() => ({
  entries: statusesCache.size(),
  name: "attendee_statuses",
}));

/** Invalidate the statuses cache (for testing or after writes). */
export const invalidateAttendeeStatusesCache = (): void => {
  statusesCache.invalidate();
};

/** Attendee statuses table — writes auto-invalidate the cache. */
export const attendeeStatusesTable = withCacheInvalidation(
  rawAttendeeStatusesTable,
  invalidateAttendeeStatusesCache,
);

/** Get all statuses, decrypted, ordered by sort_order then id (from cache). */
export const getAllAttendeeStatuses = (): Promise<AttendeeStatus[]> =>
  statusesCache.getAll();

/** Find the first cached status matching a predicate (decrypted), or null. */
const findStatus = async (
  pred: (s: AttendeeStatus) => boolean,
): Promise<AttendeeStatus | null> => {
  const all = await statusesCache.getAll();
  return all.find(pred) ?? null;
};

/** Get a single status by id (decrypted), or null. */
export const getAttendeeStatus = (id: number): Promise<AttendeeStatus | null> =>
  findStatus((s) => s.id === id);

/** The status new public bookings start in, or null if none is flagged. */
export const getPublicDefaultStatus = (): Promise<AttendeeStatus | null> =>
  findStatus((s) => s.is_public_default);

/** The status an attendee moves to once a reservation balance is paid. */
export const getPaidDefaultStatus = (): Promise<AttendeeStatus | null> =>
  findStatus((s) => s.is_paid_default);

/** The id of the public-default status, or null if none is configured. */
export const getPublicStatusId = async (): Promise<number | null> =>
  (await getPublicDefaultStatus())?.id ?? null;

/**
 * Swap the sort_order of two statuses, reading their current values so callers
 * only need the ids.
 */
export const swapAttendeeStatusOrder = async (
  id1: number,
  id2: number,
): Promise<void> => {
  await swapSortOrder("attendee_statuses", id1, id2);
  invalidateAttendeeStatusesCache();
};

/** Assign a freshly-created status the next sort_order (max + 1, always >= 1). */
export const assignNextAttendeeStatusSortOrder = async (
  id: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [id, id],
      sql: `UPDATE attendee_statuses
            SET sort_order = COALESCE(
              (SELECT MAX(sort_order) FROM attendee_statuses WHERE id != ?), 0
            ) + 1
            WHERE id = ?`,
    },
  ]);
  invalidateAttendeeStatusesCache();
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
    "SELECT id FROM attendee_statuses LIMIT 1",
  );
  if (existing.length > 0) return;
  const status = await attendeeStatusesTable.insert({
    isPaidDefault: true,
    isPublicDefault: true,
    isReservation: false,
    name: DEFAULT_ATTENDEE_STATUS_NAME,
    reservationAmount: "0",
    sortOrder: 0,
  });
  await getDb().execute({
    args: [status.id],
    sql: "UPDATE attendees SET status_id = ? WHERE status_id IS NULL",
  });
  invalidateAttendeeStatusesCache();
};
