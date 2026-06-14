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
  id: number;
  message: string;
}

/** Activity log input for create */
export type ActivityLogInput = {
  listingId?: number | null;
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
 * Log an activity
 */
export const logActivity = (
  message: string,
  listing?: ListingRef | null,
): Promise<ActivityLogEntry> =>
  activityLogTable.insert({
    listingId: toListingId(listing),
    message,
  });

/** Query activity log with optional listing filter, decrypts messages */
const queryActivityLog = async (
  listingId: number | null,
  limit: number,
): Promise<ActivityLogEntry[]> => {
  const whereClause = listingId !== null ? "WHERE listing_id = ?" : "";
  const args = listingId !== null ? [listingId, limit] : [limit];
  const rows = await queryAll<ActivityLogEntry>(
    `SELECT * FROM activity_log ${whereClause} ORDER BY created DESC, id DESC LIMIT ?`,
    args,
  );
  return Promise.all(rows.map((row) => activityLogTable.fromDb(row)));
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
      sql: "SELECT * FROM activity_log WHERE listing_id = ? ORDER BY created DESC, id DESC LIMIT ?",
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

  const logRows = resultRows<ActivityLogEntry>(results[1]!);
  const entries = await Promise.all(
    logRows.map((row) => activityLogTable.fromDb(row)),
  );

  return { entries, listing };
};
