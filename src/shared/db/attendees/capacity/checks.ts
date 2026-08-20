import type { InValue } from "@libsql/client";
import type {
  BatchAvailabilityItem,
  LineBooking,
  ListingBooking,
} from "#db/attendee-types.ts";
import {
  buildBatchCapacitySql,
  buildCapacityCondition,
  type CapacityBucket,
} from "#db/capacity.ts";
import { inPlaceholders, queryAll, requireOne } from "#db/client.ts";
import { listingGroups } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { identity, map, mapById } from "#fp";
import { capacityDateFor, countsPerDate } from "#shared/capacity-rules.ts";
import { dateToStartEnd, expandDailyRange } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Build an INSERT into listing_attendees, capacity-checked by default. */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: InValue,
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
  const row = await requireOne<Record<string, number>>(
    `SELECT ${columns}`,
    args,
  );
  return conditions.map((_, index) => row[`ok${index}`] === 1);
};

/** Check one listing's availability, including its group limits. */
export const checkListingAvailability = async (
  listingId: number,
  quantity = 1,
  date?: string | null,
  durationDays = 1,
): Promise<boolean> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) throw new Error(`Listing not found: ${listingId}`);
  const checkDate = capacityDateFor(listing.listing_type, date);
  return (
    await checkLinesCapacity([
      { date: checkDate, durationDays, listingId, quantity },
    ])
  )[0]!;
};

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
  if (countsPerDate(listing.listing_type) && date) {
    for (const day of expandDailyRange(date, item.durationDays ?? 1)) {
      bucket.perDay.set(day, (bucket.perDay.get(day) ?? 0) + item.quantity);
    }
  } else {
    bucket.total += item.quantity;
  }
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
  if (items.some((item) => item.quantity < 0)) return false;
  const listingIds = map((item: BatchAvailabilityItem) => item.listingId)(
    items,
  );
  const listingRows = await queryAll<ListingCapacityRow>(
    `SELECT listing.id, listing.max_attendees, listing.listing_type,
            listing.booked_quantity as attendee_count
       FROM listings AS listing
      WHERE listing.id IN (${inPlaceholders(listingIds)})`,
    listingIds,
  );
  const listingsById = mapById(identity<ListingCapacityRow>)(listingRows);
  const missingListingId = listingIds.find((id) => !listingsById.has(id));
  if (missingListingId !== undefined) {
    throw new Error(`Listing not found: ${missingListingId}`);
  }

  const membership = await listingGroups.getIdsByKeys(listingIds);
  const context: BatchAvailabilityContext = { date, items, listingsById };
  const listingDemand = aggregateDemand(context, (listing) => [listing.id]);
  const groupDemand = aggregateDemand(context, (_listing, item) =>
    listingGroups.idsFor(membership, item.listingId),
  );
  const { sql, args } = buildBatchCapacitySql(listingDemand, groupDemand);
  const row = await requireOne<{ fits: number }>(sql, args);
  return row.fits === 1;
};
