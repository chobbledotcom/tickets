/** Cache-aware listing records, CRUD, and basic reads. */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { mapParallel } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatch,
  inPlaceholders,
  queryAll,
  queryOnePrimary,
} from "#shared/db/client.ts";
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
import type {
  DayPrices,
  ItemImageProjection,
  Listing,
  ListingWithCount,
} from "#shared/types.ts";
import { LISTING_COUNT_SELECT } from "./sql.ts";
import {
  computeSlugIndex,
  type ListingInput,
  rawListingsTable,
} from "./table.ts";
/* jscpd:ignore-end */

export type ListingProjectionRow = Omit<ListingWithCount, "profit">;

const decryptStoredListingWithCount = async (
  row: ListingProjectionRow,
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
  row: ListingProjectionRow,
): Promise<ListingWithCount> =>
  resolveListingDefaults(
    await decryptStoredListingWithCount(row),
    settings.listingDefaults,
    settings.hasLogistics,
  );

/** Read requested listings' stored values without overlaying inherited defaults. */
export const getStoredListingsWithCountsByIds = async (
  ids: readonly number[],
): Promise<ListingWithCount[]> => {
  if (ids.length === 0) return [];
  const rows = await queryAll<ListingProjectionRow>(
    `${LISTING_COUNT_SELECT} WHERE listing.id IN (${inPlaceholders(ids)})`,
    [...ids],
  );
  return mapParallel(decryptStoredListingWithCount)(rows);
};

/** Read one listing's stored values without overlaying inherited defaults. */
export const getStoredListingWithCount = async (
  id: number,
): Promise<ListingWithCount | null> =>
  (await getStoredListingsWithCountsByIds([id]))[0] ?? null;

/** Query projected listings in newest-first order. */
export const queryListingsWithCounts = async (
  whereClause = "",
  args: InValue[] = [],
): Promise<ListingWithCount[]> => {
  const rows = await queryAll<ListingProjectionRow>(
    `${LISTING_COUNT_SELECT} ${whereClause} ORDER BY listing.created DESC, listing.id DESC`,
    args,
  );
  return mapParallel(decryptListingWithCount)(rows);
};

const queryOneListingWithCount = async (
  where: string,
  args: InValue[],
): Promise<ListingWithCount | null> =>
  (await queryListingsWithCounts(`WHERE ${where}`, args))[0] ?? null;

/** Read only the requested listings in one bounded query. */
export const getListingsWithCountsByIds = (
  ids: readonly number[],
): Promise<ListingWithCount[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : queryListingsWithCounts(`WHERE listing.id IN (${inPlaceholders(ids)})`, [
        ...ids,
      ]);

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
const EMPTY_LISTING_IMAGE: ItemImageProjection = {
  image_alt_text: "",
  image_thumb_url: "",
  image_url: "",
};

const withDayPrices = async (
  row: Listing,
  provided: DayPrices | undefined,
  projectedImage?: ItemImageProjection,
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

export type ListingOption = Pick<Listing, "active" | "id" | "name">;

type ListingOptionRow = {
  active: number;
  id: number;
  name: EnvKeyEncrypted;
};

/** Read the narrow listing option projection used by item pickers. */
export const getAllListingOptions = async (): Promise<ListingOption[]> => {
  const rows = await queryAll<ListingOptionRow>(
    "SELECT listing.id, listing.name, listing.active FROM listings AS listing ORDER BY listing.id ASC",
  );
  return mapParallel(async (row: ListingOptionRow) => ({
    active: row.active === 1,
    id: row.id,
    name: await decrypt(row.name),
  }))(rows);
};

/** Read and decrypt names only for the requested listing ids. */
export const getListingNamesByIds = envNameSource("listings", "listing").byIds;

/** Read one listing with aggregate projections from the cache. */
export const getListingWithCount = (
  id: number,
): Promise<ListingWithCount | null> => listingsCache.getById(id);

/** Read a just-written listing from the primary. */
export const getListingWithCountPrimary = async (
  id: number,
): Promise<ListingWithCount> => {
  const row = await queryOnePrimary<ListingProjectionRow>(
    `${LISTING_COUNT_SELECT} WHERE listing.id = ?`,
    [id],
  );
  return decryptListingWithCount(row!);
};

/** Read one listing by its plaintext slug. */
export const getListingWithCountBySlug = async (
  slug: string,
): Promise<ListingWithCount | null> =>
  listingsCache.getByKey(await computeSlugIndex(slug));

/** Read listings by slug in input order, retaining nulls for missing rows. */
export const getListingsBySlugsBatch = async (
  slugs: string[],
): Promise<(ListingWithCount | null)[]> => {
  if (slugs.length === 0) return [];
  const slugIndices = await Promise.all(slugs.map(computeSlugIndex));
  return listingsCache.getByKeys(slugIndices);
};
