/**
 * Read queries for attendees and their per-listing bookings.
 */

import { map, unique } from "#fp";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type {
  AttendeeWithBookings,
  ListingAttendeeRow,
} from "#shared/db/attendee-types.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { inPlaceholders, queryAll, queryOne } from "#shared/db/client.ts";
import type { Attendee } from "#shared/types.ts";

/**
 * Attendee columns for JOIN queries — only the columns actually used at runtime.
 * All PII is read from the encrypted pii_blob; per-listing status lives on listing_attendees.
 */
const ATTENDEE_COLS =
  "a.id, a.created, a.ticket_token_index, a.pii_blob, a.status_id, a.remaining_balance, a.split_logistics_agents";

/** Columns sourced from listing_attendees (per-listing data) */
const EA_COLS =
  "ea.listing_id, SUBSTR(ea.start_at, 1, 10) as date, SUBSTR(ea.end_at, 1, 10) as end_date, ea.quantity, ea.checked_in, ea.refunded, ea.price_paid, ea.attachment_downloads";

/** SELECT clause for attendee + listing_attendees JOINs (INNER JOIN context).
 * Derives `date` from start_at for the Attendee type shape. */
export const ATTENDEE_JOIN_SELECT = `${ATTENDEE_COLS}, ${EA_COLS}`;

/** SELECT clause for LEFT JOIN context — COALESCEs nullable join columns so
 * attendees with broken/missing listing_attendees linkage still appear in results
 * (with listing_id=0 as an obvious corruption indicator). */
export const ATTENDEE_LEFT_JOIN_SELECT = `${ATTENDEE_COLS}, COALESCE(ea.listing_id, 0) as listing_id, SUBSTR(ea.start_at, 1, 10) as date, SUBSTR(ea.end_at, 1, 10) as end_date, COALESCE(ea.quantity, 0) as quantity, COALESCE(ea.checked_in, 0) as checked_in, COALESCE(ea.refunded, 0) as refunded, COALESCE(ea.price_paid, 0) as price_paid, COALESCE(ea.attachment_downloads, 0) as attachment_downloads`;

/**
 * Get attendees for an listing without decrypting PII
 * Used for tests and operations that don't need decrypted data
 */
export const getAttendeesRaw = (listingId: number): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE ea.listing_id = ?
     ORDER BY a.created DESC`,
    [listingId],
  );

/**
 * Get the newest attendees across all listings without decrypting PII.
 * Used for the admin dashboard to show recent registrations.
 */
export const getNewestAttendeesRaw = (limit: number): Promise<Attendee[]> =>
  // Order by a.id DESC, not a.created: id is AUTOINCREMENT so it is
  // co-monotonic with created (newest attendee = highest id), but ordering by
  // the rowid drives the scan off the primary key with no sort over the whole
  // (unbounded) attendees table.
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     ORDER BY a.id DESC LIMIT ?`,
    [limit],
  );

/** Sort order for the admin attendees browser */
export type AttendeeSort = "newest" | "oldest";

/**
 * Attendee rows per page in the admin attendees browser. Fixed here so the
 * page size is never derived from the request — callers choose only the page.
 */
export const ATTENDEES_PAGE_SIZE = 100;

/** One page of attendee rows, plus whether a further page exists */
export type AttendeesPage = {
  rows: Attendee[];
  hasNext: boolean;
};

/**
 * Get one page of attendee+booking rows for the admin attendees browser.
 *
 * Returns one row per (attendee, listing) booking, ordered by attendee id —
 * newest or oldest first. id is AUTOINCREMENT, so it is co-monotonic with the
 * registration date but unique, making paging deterministic and index-backed
 * (no sort over the whole attendees table). When `listingId` is given, only
 * that listing's bookings are returned; otherwise every booking is included.
 *
 * The page size is fixed; callers pass a zero-based `page`. One extra row is
 * read to report `hasNext` without a separate count query, then trimmed off.
 * PII stays encrypted — decrypt with decryptAttendees before display.
 */
export const getAttendeesPage = async ({
  listingIds,
  sort,
  page,
}: {
  /** Restrict to these listings (a single selected listing, or every listing of
   * a chosen type); null is the unfiltered "all listings" view. */
  listingIds: number[] | null;
  sort: AttendeeSort;
  page: number;
}): Promise<AttendeesPage> => {
  // An empty filter set matches nothing — e.g. a type with no listings yet.
  if (listingIds?.length === 0) return { hasNext: false, rows: [] };
  // `dir` is derived from the AttendeeSort enum and the WHERE clause is fixed
  // text, so neither is user-controlled — only the bound args are.
  const dir = sort === "oldest" ? "ASC" : "DESC";
  const where = listingIds
    ? `WHERE ea.listing_id IN (${inPlaceholders(listingIds)})`
    : "";
  const limit = ATTENDEES_PAGE_SIZE + 1;
  const offset = page * ATTENDEES_PAGE_SIZE;
  const args = listingIds ? [...listingIds, limit, offset] : [limit, offset];
  const rows = await queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     ${where}
     ORDER BY a.id ${dir}
     LIMIT ? OFFSET ?`,
    args,
  );
  const hasNext = rows.length > ATTENDEES_PAGE_SIZE;
  return { hasNext, rows: hasNext ? rows.slice(0, ATTENDEES_PAGE_SIZE) : rows };
};

/**
 * Get every attendee's encrypted PII blob (one row per attendee).
 * Used to resolve bulk-email recipient lists, where only the email inside each
 * blob is needed. De-duplication of addresses happens after decryption.
 */
export const getAllAttendeePiiBlobs = async (): Promise<string[]> => {
  // Restrict the "all attendees" bulk-email audience to attendees with ≥1 real
  // (quantity > 0) line, so a no-quantity-only attendee (an interested/cancelled
  // placeholder) isn't emailed — its ticket URL would 404.
  const rows = await queryAll<{ pii_blob: string }>(
    `SELECT pii_blob FROM attendees
     WHERE EXISTS (
       SELECT 1 FROM listing_attendees
       WHERE attendee_id = attendees.id AND quantity > 0
     )`,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get the encrypted PII blobs for attendees booked onto any of the given
 * listings (one row per attendee, even if booked onto several of them).
 * Returns an empty array when no listing IDs are supplied.
 */
export const getAttendeePiiBlobsForListings = async (
  listingIds: number[],
): Promise<string[]> => {
  if (listingIds.length === 0) return [];
  const rows = await queryAll<{ pii_blob: string }>(
    // quantity > 0: only attendees with a real line on these listings — a
    // no-quantity sentinel line doesn't make someone an "attendee of X".
    `SELECT pii_blob FROM attendees
     WHERE id IN (
       SELECT DISTINCT attendee_id FROM listing_attendees
       WHERE listing_id IN (${inPlaceholders(listingIds)}) AND quantity > 0
     )`,
    listingIds,
  );
  return rows.map((r) => r.pii_blob);
};

/**
 * Get the encrypted PII blob for the attendee identified by a plaintext ticket
 * token. Used to resolve a single-attendee bulk-email recipient. Ticket tokens
 * are unique, so this matches at most one attendee; returns null when the token
 * matches none, so a stale or unknown token resolves to no recipient rather
 * than erroring.
 */
export const getAttendeePiiBlobForToken = async (
  token: string,
): Promise<string | null> => {
  const tokenIndex = await computeTicketTokenIndex(token);
  // Apply the real-line guard: an all-ghost (no-quantity-only) attendee has no
  // valid ticket URL, so the single-attendee bulk-email target resolves to no
  // recipient (a genuine one-off transactional mail would be a separate path).
  const row = await queryOne<{ pii_blob: string }>(
    `SELECT pii_blob FROM attendees
     WHERE ticket_token_index = ?
       AND EXISTS (
         SELECT 1 FROM listing_attendees
         WHERE attendee_id = attendees.id AND quantity > 0
       )
     LIMIT 1`,
    [tokenIndex],
  );
  return row ? row.pii_blob : null;
};

/**
 * Get an attendee by ID without decrypting PII
 * Used for payment callbacks and webhooks where decryption is not needed
 * Returns the attendee with encrypted fields (id, listing_id, quantity are plaintext)
 */
export const getAttendeeRaw = (id: number): Promise<Attendee | null> => {
  return queryOne<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id = ?`,
    [id],
  );
};

/**
 * Get attendees by ID without decrypting PII, one row per (attendee, booking).
 * Used by the agent run sheet, which already knows the attendee ids it needs
 * and only reads each attendee's contact fields. Returns an empty array for no
 * ids. Decrypt with decryptAttendees before display.
 */
export const getAttendeesByIds = (ids: number[]): Promise<Attendee[]> => {
  if (ids.length === 0) return Promise.resolve([]);
  return queryAll<Attendee>(
    `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
     FROM attendees a
     LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE a.id IN (${inPlaceholders(ids)})`,
    ids,
  );
};

/**
 * Get an attendee by ID (decrypted)
 * Requires private key for decryption - only available to authenticated sessions
 */
export const getAttendee = async (
  id: number,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const row = await getAttendeeRaw(id);
  return row ? decryptAttendeeFields(row, privateKey) : null;
};

/**
 * Look up attendees by plaintext tokens, returning full booking data.
 * Two queries: attendees by token index, then all listing_attendees for those attendees.
 * Returns results in the same order as input tokens (deduped). Bookings sorted
 * by start_at then listing_id for deterministic ordering.
 */
export const getAttendeesByTokens = async (
  tokens: string[],
): Promise<(AttendeeWithBookings | null)[]> => {
  // Dedupe tokens to prevent double processing
  const uniqueTokens = unique(tokens);
  const tokenIndexes = await Promise.all(
    map((t: string) => computeTicketTokenIndex(t))(uniqueTokens),
  );

  // Query 1: Get attendee base rows (no listing join)
  type AttendeeBase = {
    id: number;
    created: string;
    ticket_token_index: string;
    pii_blob: string;
    status_id: number | null;
    remaining_balance: number;
  };
  const attendeeRows = await queryAll<AttendeeBase>(
    `SELECT id, created, ticket_token_index, pii_blob, status_id, remaining_balance
     FROM attendees WHERE ticket_token_index IN (${inPlaceholders(
       tokenIndexes,
     )})`,
    tokenIndexes,
  );

  if (attendeeRows.length === 0) {
    return tokens.map(() => null);
  }

  // Query 2: Get all listing links for these attendees
  const attendeeIds = attendeeRows.map((a) => a.id);
  const bookingRows = await queryAll<
    ListingAttendeeRow & { attendee_id: number }
  >(
    `SELECT attendee_id, listing_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads
     FROM listing_attendees WHERE attendee_id IN (${inPlaceholders(
       attendeeIds,
     )})
     ORDER BY start_at, listing_id`,
    attendeeIds,
  );

  // Group bookings by attendee_id
  const bookingsByAttendee = new Map<number, ListingAttendeeRow[]>();
  for (const row of bookingRows) {
    const list = bookingsByAttendee.get(row.attendee_id) ?? [];
    list.push({
      attachment_downloads: row.attachment_downloads,
      checked_in: row.checked_in,
      end_at: row.end_at,
      listing_id: row.listing_id,
      price_paid: row.price_paid,
      quantity: row.quantity,
      refunded: row.refunded,
      start_at: row.start_at,
    });
    bookingsByAttendee.set(row.attendee_id, list);
  }

  // Build AttendeeWithBookings map by token index
  const byTokenIndex = new Map<string, AttendeeWithBookings>();
  for (const row of attendeeRows) {
    byTokenIndex.set(row.ticket_token_index, {
      bookings: bookingsByAttendee.get(row.id) ?? [],
      created: row.created,
      id: row.id,
      pii_blob: row.pii_blob,
      remaining_balance: row.remaining_balance,
      status_id: row.status_id,
      ticket_token: "", // populated after decryption by caller
      ticket_token_index: row.ticket_token_index,
    });
  }

  // Return in original token order (before dedup) using the unique index mapping
  const indexToResult = new Map(
    uniqueTokens.map((t, i) => [t, byTokenIndex.get(tokenIndexes[i]!) ?? null]),
  );
  return tokens.map((t) => indexToResult.get(t) ?? null);
};
