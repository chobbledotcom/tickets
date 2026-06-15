/**
 * Listings table operations
 */

import type { ResultSet } from "@libsql/client";
import { filter as fpFilter, reduce, sort, unique } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { addDays } from "#shared/dates.ts";
import {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
} from "#shared/db/attendees.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import {
  executeBatch,
  getDb,
  inPlaceholders,
  queryAll,
  queryBatch,
  resultRows,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
  registerCache,
} from "#shared/db/common-schema.ts";
import { col, withCacheInvalidation } from "#shared/db/table.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import {
  type Attendee,
  type DayPrices,
  type Listing,
  type ListingFields,
  type ListingType,
  type ListingWithCount,
  normalizeDurationDays,
  parseDayPrices,
} from "#shared/types.ts";
import { VALID_DAY_NAMES } from "#templates/fields.ts";

/** Default bookable days (all days of the week) */
export const DEFAULT_BOOKABLE_DAYS: string[] = [...VALID_DAY_NAMES];

/** Listing input fields for create/update (camelCase) */
export type ListingInput = {
  name: string;
  description?: string;
  date?: string;
  location?: string;
  slug: string;
  slugIndex: string;
  groupId?: number;
  maxAttendees: number;
  thankYouUrl?: string;
  unitPrice?: number;
  maxQuantity?: number;
  webhookUrl?: string;
  active?: boolean;
  fields?: ListingFields;
  closesAt?: string;
  listingType?: ListingType;
  bookableDays?: string[];
  minimumDaysBefore?: number;
  maximumDaysAfter?: number;
  imageUrl?: string;
  attachmentUrl?: string;
  attachmentName?: string;
  nonTransferable?: boolean;
  canPayMore?: boolean;
  maxPrice: number;
  hidden?: boolean;
  purchaseOnly?: boolean;
  assignBuiltSite?: boolean;
  monthsPerUnit?: number;
  initialSiteMonths?: number;
  durationDays?: number;
  customisableDays?: boolean;
  dayPrices?: DayPrices;
};

/** Compute slug index from slug for blind index lookup */
export const computeSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

const TZ_SUFFIX_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Normalize a datetime to a UTC ISO timestamp.
 * Logs and treats missing timezone offsets as UTC for legacy data.
 */
const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX_REGEX.test(value)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} missing timezone offset (${value})`,
    });
    normalized = `${value}Z`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} invalid datetime (${value})`,
    });
    return "";
  }
  return date.toISOString();
};

/** Encrypt a datetime value for DB storage (normalized to UTC) */
const encryptDatetime = (v: string, label: string): Promise<string> =>
  encrypt(normalizeUtcDatetime(v, label));

/** Decrypt an encrypted datetime from DB storage (empty → empty, otherwise → ISO) */
const decryptDatetime = async (v: string): Promise<string> => {
  const str = await decrypt(v);
  if (str === "") return "";
  return normalizeUtcDatetime(str, "stored datetime");
};

/** Encrypt closes_at for DB storage (null/empty → encrypted empty) */
export const writeClosesAt = (v: string | null): Promise<string | null> =>
  encryptDatetime(v ?? "", "closes_at");

/** Decrypt closes_at from DB storage (encrypted empty → null) */
const readClosesAt = async (v: string | null): Promise<string | null> => {
  // DB column is NOT NULL (writeClosesAt always encrypts), so v is always a string
  const result = await decryptDatetime(v!);
  return result === "" ? null : result;
};

/** Encrypt listing date for DB storage */
export const writeListingDate = (v: string): Promise<string> =>
  encryptDatetime(v, "date");

/**
 * Listings table definition
 * slug is encrypted; slug_index is HMAC for lookups
 * Write methods (insert, update, deleteById) auto-invalidate the listings cache.
 */
const rawListingsTable = defineIdTable<Listing, ListingInput>("listings", {
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  ...encryptedNameSchema(encrypt, decrypt),
  active: col.boolean(true),
  assign_built_site: col.boolean(false),
  attachment_name: col.encryptedText(encrypt, decrypt),
  attachment_url: col.encryptedText(encrypt, decrypt),
  bookable_days: col.converted<string[]>({
    default: () => [...DEFAULT_BOOKABLE_DAYS],
    read: (v) => {
      const parsed: unknown = JSON.parse(v as string);
      return Array.isArray(parsed) ? parsed : [];
    },
    write: (v) => JSON.stringify(v),
  }),
  can_pay_more: col.boolean(false),
  closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
  created: col.withDefault(() => nowIso()),
  customisable_days: col.boolean(false),
  date: { default: () => "", read: decryptDatetime, write: writeListingDate },
  day_prices: col.converted<DayPrices>({
    default: () => ({}),
    read: (v) => parseDayPrices(JSON.parse(v as string)),
    write: (v) => JSON.stringify(parseDayPrices(v)),
  }),
  description: col.encryptedText(encrypt, decrypt),
  duration_days: { default: () => 1, write: normalizeDurationDays },
  fields: col.withDefault<ListingFields>(() => "email"),
  group_id: col.withDefault(() => 0),
  hidden: col.boolean(false),
  image_url: col.encryptedText(encrypt, decrypt),
  initial_site_months: col.withDefault(() => 0),
  listing_type: col.withDefault<ListingType>(() => "standard"),
  location: col.encryptedText(encrypt, decrypt),
  max_attendees: col.simple<number>(),
  max_price: col.withDefault(() => 0),
  max_quantity: col.withDefault(() => 1),
  maximum_days_after: col.withDefault(() => 90),
  minimum_days_before: col.withDefault(() => 1),
  months_per_unit: col.withDefault(() => 0),
  non_transferable: col.boolean(false),
  purchase_only: col.boolean(false),
  thank_you_url: col.encryptedText(encrypt, decrypt),
  unit_price: col.withDefault(() => 0),
  webhook_url: col.encryptedText(encrypt, decrypt),
});

export const listingsTable = withCacheInvalidation(rawListingsTable, () =>
  invalidateListingsCache(),
);

/** Find a cached listing by ID */
const findCachedListingById = async (
  id: number,
): Promise<ListingWithCount | null> => {
  const listings = await listingsCache.getAll();
  return listings.find((e) => e.id === id) ?? null;
};

/**
 * Get a single listing by ID (from cache)
 */
export const getListing = (id: number): Promise<Listing | null> =>
  findCachedListingById(id);

/**
 * Check if a slug is already in use (optionally excluding a specific listing ID)
 * Uses slug_index for lookup (blind index)
 */
export const isSlugTaken = async (
  slug: string,
  excludeListingId?: number,
): Promise<boolean> => {
  const slugIndex = await computeSlugIndex(slug);
  const sql = excludeListingId
    ? "SELECT 1 WHERE EXISTS (SELECT 1 FROM listings WHERE slug_index = ? AND id != ?) OR EXISTS (SELECT 1 FROM groups WHERE slug_index = ?)"
    : "SELECT 1 WHERE EXISTS (SELECT 1 FROM listings WHERE slug_index = ?) OR EXISTS (SELECT 1 FROM groups WHERE slug_index = ?)";
  const args = excludeListingId
    ? [slugIndex, excludeListingId, slugIndex]
    : [slugIndex, slugIndex];
  const result = await getDb().execute({ args, sql });
  return result.rows.length > 0;
};

/**
 * Delete an listing and all its attendees in a single database round-trip.
 * Uses write batch to cascade: processed_payments → attendees → listing.
 * Reduces 3 sequential HTTP round-trips to 1.
 */
export const deleteListing = async (listingId: number): Promise<void> => {
  await executeBatch([
    // Remove listing links first
    {
      args: [listingId],
      sql: "DELETE FROM listing_attendees WHERE listing_id = ?",
    },
    // Delete orphaned attendees (no remaining listing links) and their dependent data
    {
      args: [],
      sql: "DELETE FROM processed_payments WHERE attendee_id NOT IN (SELECT attendee_id FROM listing_attendees)",
    },
    {
      args: [],
      sql: "DELETE FROM attendee_answers WHERE attendee_id NOT IN (SELECT attendee_id FROM listing_attendees)",
    },
    {
      args: [],
      sql: "DELETE FROM attendees WHERE id NOT IN (SELECT attendee_id FROM listing_attendees)",
    },
    { args: [listingId], sql: "DELETE FROM activity_log WHERE listing_id = ?" },
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ]);
  invalidateListingsCache();
};

/** Decrypt listing fields and attach an attendee count */
const decryptAndAttachCount = async (
  row: Listing,
  attendeeCount: number,
): Promise<ListingWithCount> => {
  const listing = await listingsTable.fromDb(row);
  return { ...listing, attendee_count: attendeeCount };
};

/** Extract listing row from batch result, returning null if not found */
const extractListingRow = (result: ResultSet): Listing | null =>
  resultRows<Listing>(result)[0] ?? null;

/** Extract listing from batch result, decrypt and attach count. Returns null if listing not found. */
const withBatchListing = async <T>(
  listingResult: ResultSet,
  getCount: () => number,
  build: (listing: ListingWithCount) => T,
): Promise<T | null> => {
  const listingRow = extractListingRow(listingResult);
  if (!listingRow) return null;
  return build(await decryptAndAttachCount(listingRow, getCount()));
};

/** Query listings with attendee counts, optionally filtered by a WHERE clause */
const queryListingsWithCounts = async (
  whereClause = "",
): Promise<ListingWithCount[]> => {
  const rows = await queryAll<ListingWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM listings e
     LEFT JOIN listing_attendees ea ON e.id = ea.listing_id
     ${whereClause}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );
  return Promise.all(
    rows.map((row) => decryptAndAttachCount(row, row.attendee_count)),
  );
};

const listingsCache = requestCache(() => queryListingsWithCounts());

registerCache(() => ({ entries: listingsCache.size(), name: "listings" }));

/** Invalidate the listings cache (for testing or after writes). */
export const invalidateListingsCache = (): void => {
  listingsCache.invalidate();
};

/**
 * Get all listings with attendee counts (from cache)
 */
export const getAllListings = (): Promise<ListingWithCount[]> =>
  listingsCache.getAll();

/**
 * Get listing with attendee count (from cache)
 */
export const getListingWithCount = (
  id: number,
): Promise<ListingWithCount | null> => findCachedListingById(id);

/**
 * Get listing with attendee count by slug (from cache)
 */
export const getListingWithCountBySlug = async (
  slug: string,
): Promise<ListingWithCount | null> => {
  const slugIndex = await computeSlugIndex(slug);
  const listings = await listingsCache.getAll();
  return listings.find((e) => e.slug_index === slugIndex) ?? null;
};

/** Result type for combined listing + attendees query */
export type ListingWithAttendees = {
  listing: ListingWithCount;
  attendeesRaw: Attendee[];
};

/**
 * Get listing and all attendees in a single database round-trip.
 * Uses batch API to execute both queries together, reducing latency
 * for remote databases like Turso from 2 RTTs to 1.
 * Computes attendee_count from the attendees array.
 */
export const getListingWithAttendeesRaw = async (
  id: number,
): Promise<ListingWithAttendees | null> => {
  const [listingResult, attendeesResult] = await queryBatch([
    { args: [id], sql: "SELECT * FROM listings WHERE id = ?" },
    {
      args: [id],
      sql: `SELECT ${ATTENDEE_JOIN_SELECT}
            FROM attendees a
            JOIN listing_attendees ea ON ea.attendee_id = a.id
            WHERE ea.listing_id = ?
            ORDER BY a.created DESC`,
    },
  ]);

  const attendeesRaw = resultRows<Attendee>(attendeesResult!);
  return withBatchListing(
    listingResult!,
    () => attendeesRaw.reduce((sum, a) => sum + a.quantity, 0),
    (listing) => ({ attendeesRaw, listing }),
  );
};

/** Get cached listings filtered by listing_type */
const getCachedListingsByType = async (
  type: ListingType,
): Promise<ListingWithCount[]> => {
  const listings = await listingsCache.getAll();
  return fpFilter((e: ListingWithCount) => e.listing_type === type)(listings);
};

/**
 * Get all daily listings with attendee counts (from cache).
 */
export const getAllDailyListings = (): Promise<ListingWithCount[]> =>
  getCachedListingsByType("daily");

/**
 * Get all standard listings with attendee counts (from cache).
 * Used by the calendar view to include one-time listings on their scheduled date.
 */
export const getAllStandardListings = (): Promise<ListingWithCount[]> =>
  getCachedListingsByType("standard");

/**
 * Get distinct attendee dates for daily listings.
 * Used for the calendar date picker (lightweight, no attendee data).
 */
export const getDailyListingAttendeeDates = async (): Promise<string[]> => {
  // start_at and end_at are always written together (see dateToStartEnd), so
  // filtering on both being non-null lets the row type stay honestly non-null.
  const rows = await queryAll<{ start_at: string; end_at: string }>(
    `SELECT DISTINCT ea.start_at, ea.end_at FROM listing_attendees ea
     INNER JOIN listings e ON ea.listing_id = e.id
     WHERE e.listing_type = 'daily'
       AND ea.start_at IS NOT NULL AND ea.end_at IS NOT NULL`,
  );
  // Expand each booking's [start_at, end_at) span into every calendar date it
  // covers, so multi-day bookings mark every day they occupy as selectable.
  const dates = reduce(
    (acc: string[], row: { start_at: string; end_at: string }) => {
      const endExclusive = row.end_at.slice(0, 10);
      let current = row.start_at.slice(0, 10);
      while (current < endExclusive) {
        acc.push(current);
        current = addDays(current, 1);
      }
      return acc;
    },
    [],
  )(rows);
  return sort((a: string, b: string) => a.localeCompare(b))(unique(dates));
};

/**
 * Get raw attendees for daily listings on a specific date.
 * Bounded query: only returns attendees matching the given date.
 */
export const getDailyListingAttendeesByDate = (
  date: string,
): Promise<Attendee[]> => {
  const { startAt, endAt } = dateToRange(date);
  return queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     JOIN listings e ON ea.listing_id = e.id
     WHERE e.listing_type = 'daily' AND ea.start_at < ? AND ea.end_at > ?
     ORDER BY a.created DESC`,
    [endAt, startAt],
  );
};

/**
 * Get raw attendees for a set of listing IDs.
 * Used by the calendar to load attendees for standard listings whose
 * decrypted date matches the selected calendar date.
 */
export const getAttendeesByListingIds = (
  listingIds: number[],
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE ea.listing_id IN (${inPlaceholders(listingIds)})
     ORDER BY a.created DESC`,
    listingIds,
  );

/** Result type for listing + single attendee query */
export type ListingWithAttendeeRaw = {
  listing: ListingWithCount;
  attendeeRaw: Attendee | null;
};

/**
 * Get listing and a single attendee in a single database round-trip.
 * Used for attendee management pages where we need both the listing context
 * and the specific attendee data.
 */
export const getListingWithAttendeeRaw = async (
  listingId: number,
  attendeeId: number,
): Promise<ListingWithAttendeeRaw | null> => {
  const [listingResult, attendeeResult, countResult] = await queryBatch([
    { args: [listingId], sql: "SELECT * FROM listings WHERE id = ?" },
    {
      args: [attendeeId],
      sql: `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
            FROM attendees a
            LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
            WHERE a.id = ?`,
    },
    {
      args: [listingId],
      sql: "SELECT COALESCE(SUM(quantity), 0) as count FROM listing_attendees WHERE listing_id = ?",
    },
  ]);

  return withBatchListing(
    listingResult!,
    () => resultRows<{ count: number }>(countResult!)[0]!.count,
    (listing) => ({
      attendeeRaw: resultRows<Attendee>(attendeeResult!)[0] ?? null,
      listing,
    }),
  );
};

/**
 * Get multiple listings by slugs (from cache).
 * Returns listings in the same order as the input slugs.
 * Missing or inactive listings are returned as null.
 */
export const getListingsBySlugsBatch = async (
  slugs: string[],
): Promise<(ListingWithCount | null)[]> => {
  if (slugs.length === 0) return [];

  // Compute slug indices for all slugs
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));

  const listings = await listingsCache.getAll();
  const listingBySlugIndex = new Map<string, ListingWithCount>();
  for (const listing of listings) {
    listingBySlugIndex.set(listing.slug_index, listing);
  }

  // Return listings in the same order as input slugs
  return slugIndices.map((index) => listingBySlugIndex.get(index) ?? null);
};
