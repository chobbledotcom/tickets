/** Cache-aware listing records, CRUD, and basic reads. */

/* jscpd:ignore-start */
import { mapParallel } from "#fp";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { executeBatch, queryOnePrimary } from "#shared/db/client.ts";
import { cachedEntityTable } from "#shared/db/common-schema.ts";
import { getImageFilenamesForItem } from "#shared/db/images.ts";
import {
  dayCountPriceStatements,
  getListingDayPrices,
  syncListingPrices,
} from "#shared/db/listing-prices.ts";
import { LISTING_AGGREGATE_WRITE_COLUMNS } from "#shared/db/migrations/schema/listing-aggregates.ts";
import { envNameSource } from "#shared/db/query.ts";
import { settings } from "#shared/db/settings.ts";
import { isSlugTakenAnywhere } from "#shared/db/slug-registry.ts";
import { resolveListingDefaults } from "#shared/listing-defaults.ts";
import { requireValue } from "#shared/required-value.ts";
import type {
  DayPrices,
  ItemImageColumns,
  Listing,
  ListingWithCount,
} from "#shared/types.ts";
import {
  getListingRows,
  type ListingRecordRow,
  type ListingWhere,
  listingReader,
} from "./select.ts";
import {
  computeSlugIndex,
  type ListingOption,
  listingOptionColumns,
  rawListingsTable,
} from "./table.ts";

/* jscpd:ignore-end */

const decryptStoredListingWithCount = async (
  row: ListingRecordRow,
): Promise<ListingWithCount> => {
  const listing = await rawListingsTable.fromDb(row);
  const income = Number(row.income);
  const cost = Number(row.cost);
  return {
    ...listing,
    attendee_count: row.attendee_count,
    cost,
    income,
    profit: income - cost,
    tickets_count: Number(row.tickets_count),
  };
};

/** Convert a projected DB row and overlay the effective listing defaults. */
export const decryptListingWithCount = async (
  row: ListingRecordRow,
): Promise<ListingWithCount> =>
  resolveListingDefaults(
    await decryptStoredListingWithCount(row),
    settings.listingDefaults,
    settings.features.logistics,
  );

/** Read requested listings' stored values without overlaying inherited defaults. */
export const getStoredListingsWithCountsByIds = async (
  ids: readonly number[],
): Promise<ListingWithCount[]> => {
  const rows = await getListingRows({ where: { ids: [...ids] } });
  return mapParallel(decryptStoredListingWithCount)(rows);
};

/** Read one listing's stored values without overlaying inherited defaults. */
export const getStoredListingWithCount = async (
  id: number,
): Promise<ListingWithCount | null> =>
  (await getStoredListingsWithCountsByIds([id]))[0] ?? null;

/** Read listing records in newest-first order, with inherited defaults overlaid
 * — the shared tail of the cache's three fetches. */
const getListingsWithCounts = async (
  where: ListingWhere,
): Promise<ListingWithCount[]> => {
  const rows = await getListingRows({ order: "created_desc", where });
  return mapParallel(decryptListingWithCount)(rows);
};

const LISTINGS_CACHE_TTL_MS = 30_000;
const listingsEntity = cachedEntityTable<
  Listing,
  ListingInput,
  ListingWithCount
>(
  "listings",
  rawListingsTable,
  {
    fetchAll: () => getListingsWithCounts({}),
    fetchByIds: (ids) => getListingsWithCounts({ ids: [...ids] }),
    fetchByKeys: (slugIndexes) =>
      getListingsWithCounts({ slugIndexes: [...slugIndexes] }),
    idOf: (listing) => listing.id,
    keyOf: (listing) => listing.slug_index,
    ttlMs: LISTINGS_CACHE_TTL_MS,
  },
  [
    {
      table: "listing_attendees",
      whenColumns: [...LISTING_AGGREGATE_WRITE_COLUMNS],
    },
    { table: "transfers" },
    { table: "listing_prices" },
    { table: "image_uses" },
    { table: "images" },
  ],
);
const listingsCache = listingsEntity.cache;
const rawTable = listingsEntity.table;
const EMPTY_LISTING_IMAGE: ItemImageColumns = {
  image_alt_text: "",
  image_thumb_url: "",
  image_url: "",
};

const withDayPrices = async (
  row: Listing,
  provided: DayPrices | undefined,
  projectedImage?: ItemImageColumns,
): Promise<Listing> => {
  const [day_prices, imageFilenames] = await Promise.all([
    provided ?? getListingDayPrices(row.id),
    projectedImage ?? getImageFilenamesForItem("listing", row.id),
  ]);
  return { ...row, ...imageFilenames, day_prices };
};

/** Listing CRUD with cache invalidation and listing-price synchronization. */
export const listingsTable: typeof rawTable = {
  ...rawTable,
  insert: async (input) => {
    const row = await rawTable.insert(input);
    await syncListingPrices(row.id);
    await executeBatch(dayCountPriceStatements(row.id, input.dayPrices));
    return withDayPrices(row, input.dayPrices, EMPTY_LISTING_IMAGE);
  },
  update: async (id, input) => {
    const row = await rawTable.update(id, input);
    if (!row) return null;
    await syncListingPrices(row.id);
    if (input.dayPrices !== undefined) {
      await executeBatch(dayCountPriceStatements(row.id, input.dayPrices));
    }
    return withDayPrices(row, input.dayPrices);
  },
};

/** Check whether a slug is already used, optionally excluding one listing. */
export const isSlugTaken = (
  slug: string,
  excludeListingId?: number,
): Promise<boolean> =>
  isSlugTakenAnywhere(
    slug,
    excludeListingId ? { id: excludeListingId, table: "listings" } : undefined,
  );

/** Clear the listing entity cache. */
export const invalidateListingsCache = (): void => listingsCache.invalidate();

/** Read every listing with effective defaults and aggregate projections. */
export const getAllListings = (): Promise<ListingWithCount[]> =>
  listingsCache.getAll();

/** Read every listing keyed by id. */
export const getListingsById = async (): Promise<
  Map<number, ListingWithCount>
> => new Map((await getAllListings()).map((listing) => [listing.id, listing]));

/** Read the narrow listing option projection used by item pickers. */
export const getAllListingOptions = (): Promise<ListingOption[]> =>
  listingOptionColumns.select({ alias: "listing", order: "listing.id ASC" });

/** Read and decrypt listing names without loading full records. */
export const listingNames = envNameSource("listings", "listing");

/** Read required listings in input order through the shared cache path. */
export const requireListingsWithCountsByIds = async (
  ids: number[],
): Promise<ListingWithCount[]> =>
  (await listingsCache.getByIds(ids)).map((listing, index) =>
    requireValue(listing, `Listing not found: ${ids[index]}`),
  );

/** Read listings in input order, retaining nulls for expected missing rows. */
export const getListingsWithCountsByIds = (
  ids: number[],
): Promise<(ListingWithCount | null)[]> => listingsCache.getByIds(ids);

/** Read one required listing through the shared many-listing path. */
export const requireListingWithCount = async (
  id: number,
): Promise<ListingWithCount> =>
  (await requireListingsWithCountsByIds([id]))[0]!;

/** Read one listing when absence is expected. */
export const getListingWithCount = (
  id: number,
): Promise<ListingWithCount | null> => listingsCache.getById(id);

/** Read a just-written listing from the primary, or null if it was deleted. */
export const getListingWithCountPrimary = async (
  id: number,
): Promise<ListingWithCount | null> => {
  const { sql, args } = listingReader.statement({ where: { ids: [id] } });
  const row = await queryOnePrimary<ListingRecordRow>(sql, args);
  return row === null ? null : decryptListingWithCount(row);
};

/** Read one listing by its plaintext slug when absence is expected. */
export const getListingWithCountBySlug = async (
  slug: string,
): Promise<ListingWithCount | null> =>
  listingsCache.getByKey(await computeSlugIndex(slug));

/** Read listings by slug in input order, retaining nulls for missing rows. */
export const getListingsBySlugs = async (
  slugs: string[],
): Promise<(ListingWithCount | null)[]> => {
  if (slugs.length === 0) return [];
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));
  return listingsCache.getByKeys(slugIndices);
};
