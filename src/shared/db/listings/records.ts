/** Cache-aware listing records, CRUD, and basic reads. */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { executeBatch, queryOnePrimary } from "#db/client.ts";
import { json } from "#db/codecs/kinds.ts";
import { getImageFilenamesForItem, openItemImages } from "#db/images.ts";
import { createKeyedCache } from "#db/keyed-cache.ts";
import { syncListingPrices } from "#db/listing-price-sync.ts";
import {
  dayCountPriceStatements,
  getListingDayPrices,
} from "#db/listing-prices.ts";
import { LISTING_AGGREGATE_WRITE_COLUMNS } from "#db/migrations/schema/listing-aggregates.ts";
import {
  insertRow,
  type NewRecord,
  namesByIds,
  newRecordOf,
  rowValuesOf,
  updateRow,
} from "#db/record-table.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import { slugTakenIn } from "#db/slug-registry.ts";
import { tableCache } from "#db/table-cache.ts";
import { byId, mapParallel } from "#fp";
import {
  resolveListingDate,
  resolveListingDefaults,
} from "#shared/listing-defaults.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  type DayPrices,
  DayPricesSchema,
  type ItemImageColumns,
  type Listing,
  type ListingWithCount,
} from "#types";
import {
  getListingRows,
  type ListingRecordRow,
  type ListingWhere,
  listingReader,
} from "./select.ts";

/** The day prices that a listing read projects as JSON. */
const dayPricesJson = json(DayPricesSchema, "listings.day_prices");

/** Open the projected values of a listing read and work out its profit. */
const decryptStoredListingWithCount = async ({
  cost,
  day_prices,
  image_alt_text,
  image_thumb_url,
  image_url,
  income,
  ...stored
}: ListingRecordRow): Promise<ListingWithCount> => {
  const incomeAmount = Number(income);
  const costAmount = Number(cost);
  return {
    ...stored,
    ...(await openItemImages(
      { image_alt_text, image_thumb_url, image_url },
      `listing ${stored.id}`,
    )),
    cost: costAmount,
    day_prices: await dayPricesJson.decode(day_prices, stored.id),
    income: incomeAmount,
    profit: incomeAmount - costAmount,
    tickets_count: Number(stored.tickets_count),
  };
};

/** Convert a projected DB row and overlay the effective listing values: the
 * type-derived date gate, then the inherited defaults. */
export const decryptListingWithCount = async (
  row: ListingRecordRow,
): Promise<ListingWithCount> =>
  resolveListingDefaults(
    resolveListingDate(await decryptStoredListingWithCount(row)),
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
const listingsCache = tableCache(
  tables.listings,
  createKeyedCache<ListingWithCount>({
    fetchAll: () => getListingsWithCounts({}),
    fetchByIds: (ids) => getListingsWithCounts({ ids: [...ids] }),
    // The cache keys each listing by its slug index.
    fetchByKeys: (slugIndexes) =>
      getListingsWithCounts({ slugIndexes: slugIndexes as BlindIndex[] }),
    idOf: (listing) => listing.id,
    keyOf: (listing) => listing.slug_index,
    ttlMs: LISTINGS_CACHE_TTL_MS,
  }),
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
const EMPTY_LISTING_IMAGE: ItemImageColumns = {
  image_alt_text: "",
  image_thumb_url: "",
  image_url: "",
};

const withDayPrices = async (
  row: DecodedRowOf<"listings">,
  provided: DayPrices | undefined,
  projectedImage?: ItemImageColumns,
): Promise<Listing> => {
  const [day_prices, imageFilenames] = await Promise.all([
    provided ?? getListingDayPrices(row.id),
    projectedImage ?? getImageFilenamesForItem("listing", row.id),
  ]);
  return { ...row, ...imageFilenames, day_prices };
};

/** The values of a new listing from the form input. */
export const newListingValues: (input: ListingInput) => NewRecord<"listings"> =
  newRecordOf(tables.listings, LISTING_FIELDS);

/** Store a new listing, then sync its prices. */
export const createListing = async (input: ListingInput): Promise<Listing> => {
  const row = await insertRow(tables.listings, newListingValues(input));
  await syncListingPrices(row.id);
  await executeBatch(dayCountPriceStatements(row.id, input.dayPrices));
  return withDayPrices(row, input.dayPrices, EMPTY_LISTING_IMAGE);
};

/** Change the fields of a listing that `input` names, then sync its prices.
 * Null when there is no such listing. */
export const updateListing = async (
  id: number,
  input: Partial<ListingInput>,
): Promise<Listing | null> => {
  const row = await updateRow(
    tables.listings,
    id,
    rowValuesOf(tables.listings, input),
  );
  if (!row) return null;
  await syncListingPrices(row.id);
  if (input.dayPrices !== undefined) {
    await executeBatch(dayCountPriceStatements(row.id, input.dayPrices));
  }
  return withDayPrices(row, input.dayPrices);
};

/** Check whether a slug is already used, optionally excluding one listing. */
export const isSlugTaken = slugTakenIn("listings");

/** Clear the listing entity cache. */
export const invalidateListingsCache = (): void => listingsCache.invalidate();

/** Read every listing with effective defaults and aggregate projections. */
export const getAllListings = (): Promise<ListingWithCount[]> =>
  listingsCache.getAll();

/** Read every listing keyed by id. */
export const getListingsById = async (): Promise<
  Map<number, ListingWithCount>
> => byId(await getAllListings());

/** Read and decrypt the names of these listings without loading full
 * records. */
export const listingNamesByIds = namesByIds(tables.listings);

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
  const row = await queryOnePrimary<ListingRecordRow>(
    listingReader.statement({ where: { ids: [id] } }),
  );
  return row === null ? null : decryptListingWithCount(row);
};

/** Read one listing by its plaintext slug when absence is expected. */
export const getListingWithCountBySlug = async (
  slug: string,
): Promise<ListingWithCount | null> =>
  listingsCache.getByKey(await hmacHash(slug));

/** Read listings by slug in input order, retaining nulls for missing rows. */
export const getListingsBySlugs = async (
  slugs: string[],
): Promise<(ListingWithCount | null)[]> => {
  if (slugs.length === 0) return [];
  const slugIndices = await Promise.all(slugs.map(hmacHash));
  return listingsCache.getByKeys(slugIndices);
};
