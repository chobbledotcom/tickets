/**
 * Activity log operations
 *
 * Activity logging for admin visibility.
 * Messages are encrypted - only admins can read them.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { queryAll, queryBatch, resultRows } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { col, defineTable } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import type { Listing, ListingWithCount } from "#shared/types.ts";

/** Activity log entry */
export interface ActivityLogEntry {
  created: string;
  listing_id: number | null;
  attendee_id: number | null;
  id: number;
  message: string;
}

/** Activity log input for create */
export type ActivityLogInput = {
  listingId?: number | null;
  attendeeId?: number | null;
  message: string;
};

/**
 * Activity log table definition
 * message is encrypted - decrypted only for admin view
 */
export const activityLogTable = defineTable<ActivityLogEntry, ActivityLogInput>(
  {
    name: "activity_log",
    primaryKey: "id",
    schema: {
      attendee_id: col.simple<number | null>(),
      created: col.withDefault(() => nowIso()),
      id: col.generated<number>(),
      listing_id: col.simple<number | null>(),
      message: col.encrypted<string>(encrypt, decrypt),
    },
  },
);

/** Accept an listing ID as a number or an object with `.id` */
type ListingRef = number | { id: number };

/** Extract listing ID from an ListingRef */
const toListingId = (listing?: ListingRef | null): number | null =>
  listing == null ? null : typeof listing === "number" ? listing : listing.id;

/**
 * Log an activity. Optionally associate it with a listing and/or attendee so
 * admin views can filter the log by either.
 */
export const logActivity = (
  message: string,
  listing?: ListingRef | null,
  attendeeId?: number | null,
): Promise<ActivityLogEntry> =>
  activityLogTable.insert({
    attendeeId: attendeeId ?? null,
    listingId: toListingId(listing),
    message,
  });

/** Decrypt the messages of a batch of raw activity log rows. */
const decryptLogRows = (
  rows: ActivityLogEntry[],
): Promise<ActivityLogEntry[]> =>
  Promise.all(rows.map((row) => activityLogTable.fromDb(row)));

/** Query activity log with optional listing filter, decrypts messages */
const queryActivityLog = async (
  listingId: number | null,
  limit: number,
): Promise<ActivityLogEntry[]> => {
  const whereClause = listingId !== null ? "WHERE listing_id = ?" : "";
  const args = listingId !== null ? [listingId, limit] : [limit];
  // Order by id DESC, not created DESC: id is AUTOINCREMENT so it is
  // co-monotonic with created (newest row = highest id) but, being the rowid,
  // it is served straight from the primary key / idx_activity_log_listing_id
  // without a sort over the unbounded log table.
  return decryptLogRows(
    await queryAll<ActivityLogEntry>(
      `SELECT * FROM activity_log ${whereClause} ORDER BY id DESC LIMIT ?`,
      args,
    ),
  );
};

/**
 * Get activity log entries for an listing (most recent first)
 */
export const getListingActivityLog = (
  listingId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> => queryActivityLog(listingId, limit);

/**
 * Get all activity log entries (most recent first)
 */
export const getAllActivityLog = (limit = 100): Promise<ActivityLogEntry[]> =>
  queryActivityLog(null, limit);

/**
 * Get activity log entries for a specific attendee (most recent first),
 * decrypting messages.
 */
export const getAttendeeActivityLog = async (
  attendeeId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> => {
  return decryptLogRows(
    await queryAll<ActivityLogEntry>(
      "SELECT * FROM activity_log WHERE attendee_id = ? ORDER BY id DESC LIMIT ?",
      [attendeeId, limit],
    ),
  );
};

/** Result type for listing + activity log batch query */
export type ListingWithActivityLog = {
  listing: ListingWithCount;
  entries: ActivityLogEntry[];
};

/**
 * Get listing and its activity log in a single database round-trip.
 * Uses batch API to reduce latency for remote databases.
 */
export const getListingWithActivityLog = async (
  listingId: number,
  limit = 100,
): Promise<ListingWithActivityLog | null> => {
  const results = await queryBatch([
    {
      args: [listingId],
      sql: `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
            FROM listings e
            LEFT JOIN listing_attendees ea ON e.id = ea.listing_id
            WHERE e.id = ?
            GROUP BY e.id`,
    },
    {
      args: [listingId, limit],
      sql: "SELECT * FROM activity_log WHERE listing_id = ? ORDER BY id DESC LIMIT ?",
    },
  ]);

  const listingRows = resultRows<Listing & { attendee_count: number }>(
    results[0]!,
  );
  const listingRow = listingRows[0];
  if (!listingRow) return null;

  // Decrypt listing fields
  const decryptedListing = await listingsTable.fromDb(listingRow);
  const listing: ListingWithCount = {
    ...decryptedListing,
    attendee_count: listingRow.attendee_count,
  };

  const entries = await decryptLogRows(
    resultRows<ActivityLogEntry>(results[1]!),
  );

  return { entries, listing };
};
