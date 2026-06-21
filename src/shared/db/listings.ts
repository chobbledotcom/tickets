/**
 * Listings table operations
 */

import type { InValue, ResultSet } from "@libsql/client";
import { mapParallel, reduce, sort, unique } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { addDays } from "#shared/dates.ts";
import {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
} from "#shared/db/attendees.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  queryBatch,
  queryOne,
  resetAggregates,
  resultRows,
} from "#shared/db/client.ts";
import {
  cachedEntityTable,
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { LISTING_AGGREGATE_WRITE_COLUMNS } from "#shared/db/migrations/schema.ts";
import { col } from "#shared/db/table.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
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
  usesLogistics?: boolean;
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
  uses_logistics: col.boolean(false),
  webhook_url: col.encryptedText(encrypt, decrypt),
});

/** SELECT projecting each listing plus its booked-quantity count. Callers
 * append their own WHERE and {@link LISTING_COUNT_GROUP_BY}. Shared by the
 * cache's fetchers and by the filtered group / ungrouped / activity-log queries
 * so the count source lives in one place. The count reads the precomputed
 * `booked_quantity` column (maintained by triggers on listing_attendees), so
 * this no longer joins or scans the attendee rows. */
export const LISTING_COUNT_SELECT = `SELECT listing.*, listing.booked_quantity AS attendee_count
     FROM listings AS listing`;

/** GROUP BY clause that pairs with {@link LISTING_COUNT_SELECT}. Empty now that
 * the count comes from a column rather than an aggregate over a join. */
export const LISTING_COUNT_GROUP_BY = "";

/**
 * Decrypt a listing row and attach its attendee count — the single
 * decrypt-and-attach used by the cache and every other listings-with-count
 * query. The count is read from the row's `attendee_count`, which every caller
 * supplies: the LISTING_COUNT_SELECT column (a COALESCE, so always a number) or,
 * for the batch listing+attendees helpers that compute it separately, a value
 * spread onto the row first. Takes exactly one argument so it is safe to use
 * directly as an Array.map / mapParallel callback — a second positional
 * parameter would capture the map index.
 */
export const decryptListingWithCount = async (
  row: ListingWithCount,
): Promise<ListingWithCount> => {
  const listing = await rawListingsTable.fromDb(row);
  return {
    ...listing,
    attendee_count: row.attendee_count,
    income: Number(row.income),
    tickets_count: Number(row.tickets_count),
  };
};

/**
 * Run a LISTING_COUNT_SELECT query (optional WHERE), decrypting every row in
 * newest-first order. The one place the listings-with-count query is built —
 * the cache's whole-list/batch fetchers and the group / ungrouped listing
 * queries all go through here.
 */
export const queryListingsWithCounts = async (
  whereClause = "",
  args: InValue[] = [],
): Promise<ListingWithCount[]> => {
  const rows = await queryAll<ListingWithCount>(
    `${LISTING_COUNT_SELECT} ${whereClause} ${LISTING_COUNT_GROUP_BY} ORDER BY listing.created DESC, listing.id DESC`,
    args,
  );
  return mapParallel(decryptListingWithCount)(rows);
};

/** Fetch a single listing with its count by a WHERE on the listings row. */
const queryOneListingWithCount = async (
  where: string,
  args: InValue[],
): Promise<ListingWithCount | null> =>
  (await queryListingsWithCounts(`WHERE ${where}`, args))[0] ?? null;

/**
 * Listings cache: single-record reads (by id / slug) load and decrypt only the
 * one listing they need; getAll/getByType load the whole set.
 *
 * The cache holds the trigger-maintained aggregate columns (booked_quantity,
 * tickets_count, income), which are mutated by writes to `listing_attendees`,
 * not to `listings` itself — so the cache declares a dependency on that table
 * and the db client clears it on any listing_attendees write, the same as for a
 * direct listings write. This replaces the explicit invalidate calls that every
 * attendee write path used to have to remember.
 */
const LISTINGS_CACHE_TTL_MS = 30_000;
const listingsEntity = cachedEntityTable<
  Listing,
  ListingInput,
  ListingWithCount
>(
  "listings",
  rawListingsTable,
  {
    fetchAll: () => queryListingsWithCounts(),
    fetchById: (id) => queryOneListingWithCount("listing.id = ?", [id]),
    fetchByKeys: (slugIndexes) =>
      queryListingsWithCounts(
        `WHERE listing.slug_index IN (${inPlaceholders(slugIndexes)})`,
        slugIndexes,
      ),
    idOf: (e) => e.id,
    keyOf: (e) => e.slug_index,
    ttlMs: LISTINGS_CACHE_TTL_MS,
  },
  [
    {
      table: "listing_attendees",
      whenColumns: [...LISTING_AGGREGATE_WRITE_COLUMNS],
    },
  ],
);
const listingsCache = listingsEntity.cache;

/** Listings table with CRUD operations — writes auto-invalidate the cache */
export const listingsTable = listingsEntity.table;

/**
 * Get a single listing by ID (from cache; fetches just this listing on a miss).
 */
export const getListing = (id: number): Promise<Listing | null> =>
  listingsCache.getById(id);

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
  const result = await execute(sql, args);
  return result.rows.length > 0;
};

/**
 * Delete a listing and its own bookings in a single database round-trip.
 *
 * Only the deleted listing's rows are touched: its `listing_attendees` links,
 * its `listing_questions` assignments, its `activity_log` entries, and the
 * listing itself. Attendees are deliberately left alone — an attendee booked
 * onto another listing keeps that booking (and all of its answers/payments)
 * completely untouched, and an attendee left with no bookings is simply
 * orphaned rather than purged. This scoping guarantees that deleting one
 * listing can never affect another listing's attendees.
 *
 * The `listing_questions` assignments must be cleared before the listing row.
 * Databases migrated from the legacy schema still carry that table's original
 * `FOREIGN KEY (listing_id) REFERENCES listings(id)` constraint — the migration
 * only rebuilds the attendee-related tables to drop their FKs, never this one —
 * so deleting a listing that had any questions assigned would otherwise fail
 * with "FOREIGN KEY constraint failed". Clearing the links first also stops
 * orphaned rows accumulating on fresh databases that have no such constraint.
 */
export const deleteListing = async (listingId: number): Promise<void> => {
  await executeBatch([
    {
      args: [listingId],
      sql: "DELETE FROM listing_attendees WHERE listing_id = ?",
    },
    {
      args: [listingId],
      sql: "DELETE FROM listing_questions WHERE listing_id = ?",
    },
    { args: [listingId], sql: "DELETE FROM activity_log WHERE listing_id = ?" },
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ]);
};

/** The precomputed aggregate columns every `SELECT * FROM listings` row carries. */
type ListingAggregateColumns = {
  booked_quantity: number;
  income: number;
  tickets_count: number;
};

/** Extract listing row from batch result, returning null if not found. The raw
 * `SELECT *` row carries the precomputed aggregate columns. */
const extractListingRow = (
  result: ResultSet,
): (Listing & ListingAggregateColumns) | null =>
  resultRows<Listing & ListingAggregateColumns>(result)[0] ?? null;

/** Extract listing from batch result, decrypt and attach the aggregate columns.
 * The count is the precomputed booked_quantity column (trigger-maintained SUM of
 * quantity), so callers no longer pass or compute it. Returns null if listing
 * not found. */
const withBatchListing = async <T>(
  listingResult: ResultSet,
  build: (listing: ListingWithCount) => T,
): Promise<T | null> => {
  const listingRow = extractListingRow(listingResult);
  if (!listingRow) return null;
  return build(
    await decryptListingWithCount({
      ...listingRow,
      attendee_count: listingRow.booked_quantity,
    }),
  );
};

/** Invalidate the listings cache (for testing or after writes). */
export const invalidateListingsCache = (): void => {
  listingsCache.invalidate();
};

/**
 * Get all listings with attendee counts (from cache)
 */
export const getAllListings = (): Promise<ListingWithCount[]> =>
  listingsCache.getAll();

/** Index listings by id → name, for label/link lookups across admin views
 * (the run sheet's listing column, the activity log's Listing column, …). */
export const listingNameMap = (
  listings: readonly ListingWithCount[],
): Map<number, string> => new Map(listings.map((l) => [l.id, l.name]));

/**
 * Get listing with attendee count (from cache)
 */
export const getListingWithCount = (
  id: number,
): Promise<ListingWithCount | null> => listingsCache.getById(id);

/**
 * Get listing with attendee count by slug (from cache)
 */
export const getListingWithCountBySlug = async (
  slug: string,
): Promise<ListingWithCount | null> =>
  listingsCache.getByKey(await computeSlugIndex(slug));

export const LISTING_AGGREGATE_FIELDS = [
  "booked_quantity",
  "tickets_count",
  "income",
] as const;

export type ListingAggregateField = (typeof LISTING_AGGREGATE_FIELDS)[number];

export type ListingAggregateValues = Record<ListingAggregateField, number>;

export type ListingAggregateRecalculation = Record<
  ListingAggregateField,
  { current: number; recalculated: number }
>;

/** The listing aggregate columns as they would be if rebuilt from attendee rows. */
export const getListingAggregateRecalculation = async (
  listing: ListingWithCount,
): Promise<ListingAggregateRecalculation> => {
  const row = (await queryOne<ListingAggregateValues>(
    `SELECT
       COALESCE(SUM(quantity), 0) AS booked_quantity,
       COUNT(*) AS tickets_count,
       COALESCE(SUM(price_paid), 0) AS income
     FROM listing_attendees
     WHERE listing_id = ?`,
    [listing.id],
  ))!;
  return {
    booked_quantity: {
      current: listing.attendee_count,
      recalculated: row.booked_quantity,
    },
    income: { current: listing.income, recalculated: row.income },
    tickets_count: {
      current: listing.tickets_count,
      recalculated: row.tickets_count,
    },
  };
};

/** Manually set every editable listing aggregate from the edit form. */
export const updateListingAggregateValues = async (
  listingId: number,
  values: ListingAggregateValues,
): Promise<void> => {
  await execute(
    "UPDATE listings SET booked_quantity = ?, tickets_count = ?, income = ? WHERE id = ?",
    [values.booked_quantity, values.tickets_count, values.income, listingId],
  );
};

const aggregateResetSql: Record<ListingAggregateField, string> = {
  booked_quantity:
    "booked_quantity = COALESCE((SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = ?), 0)",
  income:
    "income = COALESCE((SELECT SUM(price_paid) FROM listing_attendees WHERE listing_id = ?), 0)",
  tickets_count:
    "tickets_count = (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = ?)",
};

/** Reset selected listing aggregate columns from actual attendee rows. */
export const resetListingAggregateFields = async (
  listingId: number,
  fields: ListingAggregateField[],
): Promise<void> => {
  await resetAggregates("listings", listingId, fields, aggregateResetSql);
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
 * attendee_count comes from the listing's precomputed booked_quantity column.
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
  return withBatchListing(listingResult!, (listing) => ({
    attendeesRaw,
    listing,
  }));
};

/**
 * Get distinct attendee dates for daily listings.
 * Used for the calendar date picker (lightweight, no attendee data).
 */
export const getDailyListingAttendeeDates = async (): Promise<string[]> => {
  // start_at and end_at are always written together (see dateToStartEnd), so
  // filtering on both being non-null lets the row type stay honestly non-null.
  const rows = await queryAll<{ start_at: string; end_at: string }>(
    `SELECT DISTINCT ea.start_at, ea.end_at FROM listing_attendees ea
     INNER JOIN listings AS listing ON ea.listing_id = listing.id
     WHERE listing.listing_type = 'daily'
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
     JOIN listings AS listing ON ea.listing_id = listing.id
     WHERE listing.listing_type = 'daily' AND ea.start_at < ? AND ea.end_at > ?
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
  const [listingResult, attendeeResult] = await queryBatch([
    { args: [listingId], sql: "SELECT * FROM listings WHERE id = ?" },
    {
      args: [attendeeId],
      sql: `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
            FROM attendees a
            LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
            WHERE a.id = ?`,
    },
  ]);

  return withBatchListing(listingResult!, (listing) => ({
    attendeeRaw: resultRows<Attendee>(attendeeResult!)[0] ?? null,
    listing,
  }));
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
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));
  return listingsCache.getByKeys(slugIndices);
};
