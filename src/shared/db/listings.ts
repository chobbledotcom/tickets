/**
 * Listings table operations
 */

import type { InValue, ResultSet } from "@libsql/client";
import { mapParallel, reduce, sort, unique } from "#fp";
import { inOwnTx, ledgerTx } from "#shared/accounting/ledger-tx.ts";
import {
  accountBalanceSubquery,
  creditsLessWriteoffDebits,
  revenueBreakdownColumns,
  revenueBreakdownScope,
} from "#shared/accounting/projection-sql.ts";
import {
  andPrefixed,
  emptyRange,
  type LedgerRange,
  occurredAtRange,
} from "#shared/accounting/range.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { addDays } from "#shared/dates.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
} from "#shared/db/attendees/queries.ts";
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
import {
  LISTING_AGGREGATE_WRITE_COLUMNS,
  TICKET_COUNTS_PREDICATE,
  ticketCountPredicateFor,
  ticketCountSumExpr,
} from "#shared/db/migrations/schema.ts";
import { nameMapByIds } from "#shared/db/query.ts";
import { settings } from "#shared/db/settings.ts";
import { col } from "#shared/db/table.ts";
import type { CatalogSourceListing } from "#shared/external-order.ts";
import { resolveListingDefaults } from "#shared/listing-defaults.ts";
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
  useDefaults?: boolean;
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
  use_defaults: col.boolean(false),
  uses_logistics: col.boolean(false),
  webhook_url: col.encryptedText(encrypt, decrypt),
});

/**
 * Subquery projecting a listing's income from the ledger: the GROSS sum of every
 * revenue-recognising leg credited to the listing's `revenue` account, minus
 * manual write-offs (a `revenue:L → writeoff` adjustment from decision 14). It is
 * deliberately NOT `balanceOf(revenue:L)`, so an ordinary refund
 * (`revenue:L → attendee`) does NOT reduce income — matching the legacy
 * `SUM(price_paid)` admins saw — while a deliberate manual correction does. With
 * no `writeoff` legs (production today) it equals the plain gross credit sum, so
 * the refinement is backward-compatible. `idExpr` is the SQL for the listing's id
 * in the surrounding query (e.g. `listing.id` or `listings.id`). Shared by
 * {@link LISTING_COUNT_SELECT} and the batch `SELECT *` loaders so income is read
 * from the ledger in exactly one place, never off the now-dropped column. The
 * trailing `AS income` names the projected column.
 */
export const listingIncomeSubquery = (idExpr: string): string =>
  `${creditsLessWriteoffDebits("revenue", idExpr)} AS income`;

const listingCostSubquery = (idExpr: string): string =>
  `-${accountBalanceSubquery("cost", idExpr)} AS cost`;

const listingProfitSubquery = (idExpr: string): string =>
  `(${creditsLessWriteoffDebits("revenue", idExpr)} + ${accountBalanceSubquery(
    "cost",
    idExpr,
  )}) AS profit`;

const listingMoneySubqueries = (idExpr: string): string =>
  [
    listingIncomeSubquery(idExpr),
    listingCostSubquery(idExpr),
    listingProfitSubquery(idExpr),
  ].join(", ");

/**
 * A transparent breakdown of a listing's `revenue:<id>` account, deriving BOTH
 * the reported figure and the live ledger balance from the same running totals so
 * the two never appear to disagree without the reconciliation being visible:
 *
 * - `grossSales` — Σ `sale` credits to the account (gross ticket sales).
 * - `externalIncome` — Σ owner-entered listing income received outside checkout.
 * - `manualAdjustments` — signed Σ of `adjustment` legs vs `writeoff`:
 *   `(writeoff → revenue write-ups) − (revenue → writeoff write-downs)`. Positive
 *   is a net write-up, negative a net write-down (decision 14).
 * - `recognisedIncome` = `grossSales + externalIncome + manualAdjustments` — the
 *   refund-agnostic figure shown as the listing's income and used in exports.
 *   Equals the existing {@link listingIncomeSubquery} /
 *   `creditsLessWriteoffDebits` projection.
 * - `refunds` — Σ `refund_sale` debits from the account, as a positive magnitude
 *   that is then subtracted.
 * - `externalCosts` — Σ owner-entered costs paid outside checkout.
 * - `netBalance` = `recognisedIncome − refunds − externalCosts` — the raw signed
 *   account balance a refund or manual cost also reduces (can go negative). Equals
 *   `accountBalance(revenueAccount(id))`.
 *
 * One grouped query of conditional SUMs over only this account's own legs (the
 * source/destination scan stays index-backed), never loading per-transfer rows —
 * a popular listing could have thousands.
 */
export type ListingRevenueBreakdown = {
  grossSales: number;
  externalIncome: number;
  manualAdjustments: number;
  recognisedIncome: number;
  refunds: number;
  externalCosts: number;
  netBalance: number;
};

type RevenueBreakdownRow = {
  gross_sales: number | bigint;
  external_income: number | bigint;
  write_ups: number | bigint;
  write_downs: number | bigint;
  refunds: number | bigint;
  external_costs: number | bigint;
};

export const listingRevenueBreakdown = async (
  listingId: number,
  range: LedgerRange = emptyRange,
): Promise<ListingRevenueBreakdown> => {
  // Ledger account ids are stored as TEXT; the builders compare against
  // `CAST(<idExpr> AS TEXT)`. The id is bound as a STRING (not the number — a
  // numeric bind would cast to "1.0" and match nothing) once per predicate the
  // builders emit: six in the column list, two in the own-legs scope. The
  // optional `range` appends its own `occurred_at` bounds (and their args) so a
  // date-filtered ledger view reads the same breakdown over just that window.
  const r = occurredAtRange(range);
  const args: InValue[] = [...Array(8).fill(String(listingId)), ...r.args];
  const row = (await queryOne<RevenueBreakdownRow>(
    `SELECT ${revenueBreakdownColumns("?")}
       FROM transfers WHERE (${revenueBreakdownScope("?")})${andPrefixed(r.clause)}`,
    args,
  ))!;
  const grossSales = Number(row.gross_sales);
  const externalIncome = Number(row.external_income);
  const manualAdjustments = Number(row.write_ups) - Number(row.write_downs);
  const refunds = Number(row.refunds);
  const externalCosts = Number(row.external_costs);
  const recognisedIncome = grossSales + externalIncome + manualAdjustments;
  return {
    externalCosts,
    externalIncome,
    grossSales,
    manualAdjustments,
    netBalance: recognisedIncome - refunds - externalCosts,
    recognisedIncome,
    refunds,
  };
};

/** SELECT projecting each listing plus its booked-quantity count. Callers
 * append their own WHERE and {@link LISTING_COUNT_GROUP_BY}. Shared by the
 * cache's fetchers and by the filtered group / ungrouped / activity-log queries
 * so the count source lives in one place. The count reads the precomputed
 * `booked_quantity` column (maintained by triggers on listing_attendees), so
 * this no longer joins or scans the attendee rows. */
export const LISTING_COUNT_SELECT = `SELECT listing.*, listing.booked_quantity AS attendee_count,
       ${listingMoneySubqueries("listing.id")}
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
  // Overlay the operator's listing defaults when this listing inherits them, so
  // every consumer (public pages, booking, webhooks, exports, the edit form)
  // sees the effective value live rather than this row's own stored value.
  return resolveListingDefaults(
    {
      ...listing,
      attendee_count: row.attendee_count,
      cost: Number(row.cost),
      income: Number(row.income),
      profit: Number(row.profit),
      tickets_count: Number(row.tickets_count),
    },
    settings.listingDefaults,
  );
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
    // Income is projected from the ledger, so a transfer write — a new booking's
    // revenue leg, or a refund reversal — must refresh the cached listing income.
    { table: "transfers" },
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
 * its `listing_questions` assignments, its `listing_parents` edges (on either
 * side), its `activity_log` entries, and the listing itself. Attendees are
 * deliberately left alone — an attendee booked
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
    {
      // Remove this listing from both sides of every parent/child edge.
      args: [listingId, listingId],
      sql: "DELETE FROM listing_parents WHERE parent_listing_id = ? OR child_listing_id = ?",
    },
    { args: [listingId], sql: "DELETE FROM activity_log WHERE listing_id = ?" },
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ]);
};

/** The aggregate columns a listing-load row carries: `booked_quantity` and
 *  `tickets_count` are trigger-maintained columns on `listings`; money fields are
 *  projected from the ledger by {@link listingMoneySubqueries}, which every
 *  loader must select alongside `listings.*` (the columns themselves are gone). */
type ListingAggregateColumns = {
  booked_quantity: number;
  cost: number;
  income: number;
  profit: number;
  tickets_count: number;
};

/** Extract listing row from batch result, returning null if not found. The row
 * carries the trigger-maintained count columns plus the ledger income projection
 * its loader selected. */
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

/** All listings keyed by id (built from the cached `getAllListings`). */
export const getListingsById = async (): Promise<
  Map<number, ListingWithCount>
> => new Map((await getAllListings()).map((l) => [l.id, l]));

/** Bounded id → name lookup for the given listings: selects and decrypts only
 * their names, rather than loading the whole listings cache like getAllListings.
 * Empty ids ⇒ empty map (no query). Used for link labels in the activity log. */
export const getListingNamesByIds = (
  ids: number[],
): Promise<Map<number, string>> =>
  nameMapByIds("listings", "listing", "name", ids, (raw: string) =>
    decrypt(raw),
  );

/** Narrow catalog query for the public `/order.js` route. Filters to active,
 * non-hidden listings in SQL *before* decryption and selects only the columns
 * the external-order widget serializes, so an unauthenticated module request
 * never decrypts hidden/inactive listings' descriptions, locations, or dates —
 * unlike loading the whole listings cache via getAllListings(). */
export const getCatalogListings = async (): Promise<CatalogSourceListing[]> => {
  // Raw row: like the source listing but with the encrypted slug/name still
  // encrypted and the booleans as SQLite 0/1 integers.
  type CatalogRow = Omit<
    CatalogSourceListing,
    "active" | "hidden" | "customisable_days" | "can_pay_more"
  > & { customisable_days: number; can_pay_more: number };
  const rows = await queryAll<CatalogRow>(
    `SELECT listing.id, listing.slug, listing.name, listing.unit_price,
            listing.listing_type, listing.customisable_days, listing.can_pay_more
     FROM listings AS listing
     WHERE listing.active = 1 AND listing.hidden = 0`,
  );
  return Promise.all(
    rows.map(async (row) => ({
      active: true,
      can_pay_more: row.can_pay_more === 1,
      customisable_days: row.customisable_days === 1,
      hidden: false,
      id: row.id,
      listing_type: row.listing_type,
      name: await decrypt(row.name),
      slug: await decrypt(row.slug),
      unit_price: row.unit_price,
    })),
  );
};

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
] as const;

export type ListingAggregateField = (typeof LISTING_AGGREGATE_FIELDS)[number];

export type ListingAggregateValues = Record<ListingAggregateField, number>;

export type ListingAggregateRecalculation = Record<
  ListingAggregateField,
  { current: number; recalculated: number }
>;

/**
 * Recalculate every listing aggregate in one pass. tickets_count counts only
 * quantity > 0 rows (see {@link TICKET_COUNTS_PREDICATE}), while booked_quantity
 * sums over ALL rows (the no-quantity sentinel adds 0 to capacity). Income is no
 * longer an aggregate column — it is projected from the transfers ledger at read
 * time, not recomputed here. Exported for the shared-predicate guard test.
 */
export const LISTING_AGGREGATE_RECALC_SQL = `SELECT
       COALESCE(SUM(quantity), 0) AS booked_quantity,
       ${ticketCountSumExpr()} AS tickets_count
     FROM listing_attendees
     WHERE listing_id = ?`;

/** The listing aggregate columns as they would be if rebuilt from attendee rows. */
export const getListingAggregateRecalculation = async (
  listing: ListingWithCount,
): Promise<ListingAggregateRecalculation> => {
  const row = (await queryOne<ListingAggregateValues>(
    LISTING_AGGREGATE_RECALC_SQL,
    [listing.id],
  ))!;
  return {
    booked_quantity: {
      current: listing.attendee_count,
      recalculated: row.booked_quantity,
    },
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
    "UPDATE listings SET booked_quantity = ?, tickets_count = ? WHERE id = ?",
    [values.booked_quantity, values.tickets_count, listingId],
  );
};

/**
 * Correct a listing's projected income to `targetIncome` in its own write
 * transaction — the standalone form of `ledgerTx.correct.income` (see
 * {@link ledgerTx}). Raising income credits `revenue:L` (`writeoff → revenue`),
 * which {@link listingIncomeSubquery} counts; lowering it debits
 * `revenue:L → writeoff`, which the same projection subtracts. The delta is
 * recomputed from the current projection read inside the transaction, so
 * re-submitting the same target is idempotent and a no-op when already met.
 */
export const adjustListingIncome = inOwnTx(ledgerTx.correct.income);

/**
 * Per-field "rebuild this aggregate from attendee rows" fragments. Each is an
 * independent subquery, so tickets_count adds the {@link TICKET_COUNTS_PREDICATE}
 * to ITS OWN WHERE (excluding quantity-0 lines) without touching the
 * booked_quantity sum. Income is not here — it projects from the transfers
 * ledger (see {@link adjustListingIncome}). Exported for the predicate guard test.
 */
export const aggregateResetSql: Record<ListingAggregateField, string> = {
  booked_quantity:
    "booked_quantity = COALESCE((SELECT SUM(quantity) FROM listing_attendees WHERE listing_id = ?), 0)",
  tickets_count: `tickets_count = (SELECT COUNT(*) FROM listing_attendees WHERE listing_id = ? AND ${ticketCountPredicateFor(
    "quantity",
    "attendee_id",
  )})`,
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
    {
      args: [id],
      sql: `SELECT listings.*, ${listingMoneySubqueries("listings.id")} FROM listings WHERE id = ?`,
    },
    {
      args: [id],
      sql: `SELECT ${ATTENDEE_JOIN_SELECT}
            FROM attendees a
            JOIN listing_attendees ea ON ea.attendee_id = a.id
            WHERE ea.listing_id = ? AND a.kind = '${ATTENDEE_KIND}'
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
    // quantity > 0: a no-quantity sentinel line is not an operational booking, so
    // it must not mark a calendar date as occupied.
    `SELECT DISTINCT ea.start_at, ea.end_at FROM listing_attendees ea
     INNER JOIN listings AS listing ON ea.listing_id = listing.id
     WHERE listing.listing_type = 'daily'
       AND ea.start_at IS NOT NULL AND ea.end_at IS NOT NULL
       AND ea.quantity > 0`,
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
    // quantity > 0: exclude no-quantity sentinel lines from the daily calendar.
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     JOIN listings AS listing ON ea.listing_id = listing.id
     WHERE listing.listing_type = 'daily' AND ea.start_at < ? AND ea.end_at > ?
       AND ea.quantity > 0
     ORDER BY a.created DESC`,
    [endAt, startAt],
  );
};

/**
 * Get raw attendees for a set of listing IDs.
 * Used by the calendar to load attendees for standard listings whose
 * decrypted date matches the selected calendar date.
 *
 * `activeOnly` is an opt-in `quantity > 0` filter: the operational callers (the
 * ICS feed and the admin calendar's standard-listing rows + CSV) pass `true` to
 * drop no-quantity sentinel lines, while the admin group-detail roster passes
 * `false` (the default) so it keeps showing ghost rows. The filter is opt-in —
 * never applied unconditionally to this shared helper — so a record/detail
 * caller can't accidentally lose its ghost rows.
 */
type ListingAttendeeKindScope = "attendees" | "attendees-and-servicing";

type ListingAttendeeFilter = {
  activeOnly?: boolean;
  kindScope?: ListingAttendeeKindScope;
};

const listingAttendeeFilter = (
  filter: boolean | ListingAttendeeFilter = false,
): Required<ListingAttendeeFilter> =>
  typeof filter === "boolean"
    ? { activeOnly: filter, kindScope: "attendees" }
    : {
        activeOnly: filter.activeOnly ?? false,
        kindScope: filter.kindScope ?? "attendees",
      };

const attendeeKindClause = (kindScope: ListingAttendeeKindScope): string =>
  kindScope === "attendees-and-servicing"
    ? `a.kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}')`
    : `a.kind = '${ATTENDEE_KIND}'`;

export const getAttendeesByListingIds = (
  listingIds: number[],
  filter: boolean | ListingAttendeeFilter = false,
): Promise<Attendee[]> => {
  if (listingIds.length === 0) return Promise.resolve([]);
  const { activeOnly, kindScope } = listingAttendeeFilter(filter);
  return queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
     FROM attendees a
     JOIN listing_attendees ea ON ea.attendee_id = a.id
     WHERE ea.listing_id IN (${inPlaceholders(listingIds)})
       AND ${attendeeKindClause(kindScope)}
       ${activeOnly ? "AND ea.quantity > 0" : ""}
     ORDER BY a.created DESC`,
    listingIds,
  );
};

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
    {
      args: [listingId],
      sql: `SELECT listings.*, ${listingMoneySubqueries("listings.id")} FROM listings WHERE id = ?`,
    },
    {
      args: [attendeeId],
      sql: `SELECT ${ATTENDEE_LEFT_JOIN_SELECT}
            FROM attendees a
            LEFT JOIN listing_attendees ea ON ea.attendee_id = a.id
            WHERE a.id = ? AND a.kind = '${ATTENDEE_KIND}'`,
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
