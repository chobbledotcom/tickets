import type { InValue } from "@libsql/client";
import { assert } from "@std/assert";
import { byId, groupBy, unique } from "#fp";
import { capacityDateFor, countsPerDate } from "#shared/capacity-rules.ts";
import type {
  BatchAvailabilityItem,
  LineBooking,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import {
  buildBatchCapacityCondition,
  buildCapacityCondition,
  type CapacityBucket,
} from "#shared/db/capacity.ts";
import {
  andConditions,
  inPlaceholders,
  type PrimaryReadOptions,
  queryBatch,
  queryBatchPrimary,
  queryOne,
  resultRows,
  type SqlStatement,
} from "#shared/db/client.ts";
import { ascending } from "#shared/types.ts";
import { useListingById } from "./listing.ts";
import { dateToStartEnd, expandDailyRange } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** The quantity, listing, and duration fields used by capacity checks. */
export const bookingCapacityFields = (
  booking: Pick<LineBooking, "durationDays" | "listingId" | "quantity">,
): Omit<BatchAvailabilityItem, "date"> => ({
  durationDays: booking.durationDays,
  listingId: booking.listingId,
  quantity: booking.quantity,
});

/** Build an INSERT into listing_attendees, capacity-checked by default. */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: number,
  allowOverbook = false,
): { sql: string; args: InValue[] } => {
  const {
    listingId,
    quantity = 1,
    date = null,
    durationDays = 1,
    orderToken = "",
    parentListingId = 0,
    packageGroupId = 0,
  } = booking;
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const args: InValue[] = [listingId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(
    startAt,
    endAt,
    quantity,
    orderToken,
    parentListingId,
    packageGroupId,
  );
  const insertSelect = `INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?, ?, ?`;
  if (allowOverbook) return { args, sql: insertSelect };

  const condition = buildCapacityCondition(
    listingId,
    quantity,
    date,
    undefined,
    durationDays,
  );
  args.push(...condition.args);
  return { args, sql: `${insertSelect}\n          WHERE ${condition.sql}` };
};

/** Check several capacity conditions in one query. */
export const checkLinesCapacity = async (
  bookings: LineBooking[],
  excludeAttendeeId?: number,
): Promise<boolean[]> => {
  if (bookings.length === 0) return [];
  const conditions = bookings.map((booking) =>
    buildCapacityCondition(
      booking.listingId,
      booking.quantity,
      booking.date,
      excludeAttendeeId,
      booking.durationDays,
    ),
  );
  const columns = conditions
    .map((condition, index) => `(${condition.sql}) AS ok${index}`)
    .join(", ");
  const args = conditions.flatMap((condition) => condition.args);
  const row = (await queryOne<Record<string, number>>(
    `SELECT ${columns}`,
    args,
  ))!;
  return conditions.map((_, index) => row[`ok${index}`] === 1);
};

/** Check one listing's availability, including its group limits. */
export const checkListingAvailability = async (
  listingId: number,
  quantity = 1,
  date?: string | null,
  durationDays = 1,
): Promise<boolean> =>
  useListingById(listingId, false, async (listing) => {
    const checkDate = capacityDateFor(listing.listing_type, date);
    return (
      await checkLinesCapacity([
        { date: checkDate, durationDays, listingId, quantity },
      ])
    )[0]!;
  });

type DemandBucket = CapacityBucket;

const getOrCreateBucket = <K>(
  buckets: Map<K, DemandBucket>,
  key: K,
): DemandBucket => {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { perDay: new Map(), total: 0 };
    buckets.set(key, bucket);
  }
  return bucket;
};

const addDemandToBucket = (
  bucket: DemandBucket,
  listing: ListingCapacityRow,
  item: BatchAvailabilityItem,
  date: string | null | undefined,
): void => {
  const bookingDate = item.date === undefined ? date : item.date;
  if (countsPerDate(listing.listing_type) && bookingDate) {
    for (const day of expandDailyRange(bookingDate, item.durationDays ?? 1)) {
      bucket.perDay.set(day, (bucket.perDay.get(day) ?? 0) + item.quantity);
    }
  } else {
    bucket.total += item.quantity;
  }
};

type GroupMembershipRow = { group_id: number; listing_id: number };

const membershipFor = (
  membership: ReadonlyMap<number, number[]>,
  listingId: number,
): number[] => {
  const groupIds = membership.get(listingId);
  assert(groupIds, `Missing capacity membership for listing ${listingId}`);
  return groupIds;
};

/** Refuse a following write if listing types or group memberships changed after
 * the primary-pinned capacity snapshot was prepared. */
const capacityMetadataCondition = (
  listings: ListingCapacityRow[],
  membership: ReadonlyMap<number, number[]>,
): SqlStatement => ({
  args: [
    JSON.stringify(
      listings.map((listing) => ({
        groupIds: membershipFor(membership, listing.id).toSorted(ascending),
        id: listing.id,
        listingType: listing.listing_type,
      })),
    ),
  ],
  sql: `NOT EXISTS (
    SELECT 1
      FROM json_each(?) AS expectedListing
      LEFT JOIN listings AS listing
        ON listing.id = json_extract(expectedListing.value, '$.id')
     WHERE listing.id IS NULL
        OR listing.listing_type != json_extract(expectedListing.value, '$.listingType')
        OR EXISTS (
          SELECT 1 FROM group_listings AS liveGroup
           WHERE liveGroup.listing_id = json_extract(expectedListing.value, '$.id')
             AND liveGroup.group_id NOT IN (
               SELECT CAST(expectedGroup.value AS INTEGER)
                 FROM json_each(expectedListing.value, '$.groupIds') AS expectedGroup
             )
        )
        OR EXISTS (
          SELECT 1
            FROM json_each(expectedListing.value, '$.groupIds') AS expectedGroup
           WHERE NOT EXISTS (
             SELECT 1 FROM group_listings AS liveGroup
              WHERE liveGroup.listing_id = json_extract(expectedListing.value, '$.id')
                AND liveGroup.group_id = CAST(expectedGroup.value AS INTEGER)
           )
        )
  )`,
});

/** Prepare the live whole-cart condition, optionally pinned to the primary for
 * a condition that gates a following write. */
export const currentBatchCapacityCondition = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
  { primary = false }: PrimaryReadOptions = {},
): Promise<SqlStatement | null> => {
  if (items.length === 0) return { args: [], sql: "1 = 1" };
  if (items.some((item) => item.quantity < 0)) return null;
  const listingIds = unique(items.map((item) => item.listingId));
  const placeholders = inPlaceholders(listingIds);
  const [listingResult, membershipResult] = await (primary
    ? queryBatchPrimary
    : queryBatch)([
    {
      args: listingIds,
      sql: `SELECT listing.id, listing.max_attendees, listing.listing_type,
                   listing.booked_quantity AS attendee_count
              FROM listings AS listing
             WHERE listing.id IN (${placeholders})`,
    },
    {
      args: listingIds,
      sql: `SELECT groupListing.listing_id, groupListing.group_id
              FROM group_listings AS groupListing
             WHERE groupListing.listing_id IN (${placeholders})`,
    },
  ]);
  const listings = resultRows<ListingCapacityRow>(listingResult!);
  if (listings.length !== listingIds.length) return null;
  const membershipRows = resultRows<GroupMembershipRow>(membershipResult!);
  const membershipRowsByListing = groupBy(
    membershipRows,
    (row) => row.listing_id,
  );
  const membership = new Map(
    listingIds.map((listingId) => [
      listingId,
      (membershipRowsByListing.get(listingId) ?? []).map((row) => row.group_id),
    ]),
  );
  const context: BatchAvailabilityContext = {
    date,
    items,
    listingsById: byId(listings),
  };
  return andConditions([
    buildBatchCapacityCondition(
      aggregateDemand(context, (listing) => [listing.id]),
      aggregateDemand(context, (_listing, item) =>
        membershipFor(membership, item.listingId),
      ),
    ),
    capacityMetadataCondition(listings, membership),
  ]);
};

interface BatchAvailabilityContext {
  date: string | null | undefined;
  items: BatchAvailabilityItem[];
  listingsById: Map<number, ListingCapacityRow>;
}

const aggregateDemand = (
  context: BatchAvailabilityContext,
  keysFor: (
    listing: ListingCapacityRow,
    item: BatchAvailabilityItem,
  ) => number[],
): Map<number, DemandBucket> => {
  const { items, listingsById, date } = context;
  const buckets = new Map<number, DemandBucket>();
  for (const item of items) {
    const listing = listingsById.get(item.listingId)!;
    for (const key of keysFor(listing, item)) {
      addDemandToBucket(getOrCreateBucket(buckets, key), listing, item, date);
    }
  }
  return buckets;
};

/** Check a whole booking batch in one preflight query. */
export const checkBatchAvailabilityImpl = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => {
  if (items.length === 0) return true;
  const condition = await currentBatchCapacityCondition(items, date);
  if (!condition) return false;
  const row = (await queryOne<{ fits: number }>(
    `SELECT CASE WHEN ${condition.sql} THEN 1 ELSE 0 END AS fits`,
    condition.args,
  ))!;
  return row.fits === 1;
};
