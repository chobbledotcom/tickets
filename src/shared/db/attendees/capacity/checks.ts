import type { InValue } from "@libsql/client";
import type {
  BatchAvailabilityItem,
  LineBooking,
  ListingBooking,
} from "#db/attendee-types.ts";
import { buildCapacityCondition, capacityConditionFor } from "#db/capacity.ts";
import {
  addDemandToBucket,
  buildCartCapacitySql,
  type CapacityBucket,
  type CartDemand,
  getOrCreateBucket,
} from "#db/capacity-batch.ts";
import {
  inPlaceholders,
  queryAll,
  requireOne,
  type SqlStatement,
} from "#db/client.ts";
import { listingGroups } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { type NumberedSql, numberedStatement } from "#db/numbered-statement.ts";
import { identity, map, mapById, unique } from "#fp";
import { capacityDateFor } from "#shared/capacity-rules.ts";
import { dateToStartEnd } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Build an INSERT into listing_attendees, capacity-checked by default. A
 * zero-quantity booking carries no capacity or active condition: it demands
 * no places, so it can land on a full or inactive listing too — but by
 * default it still names a listing that must exist, because
 * listing_attendees has no foreign key. An overbook caller (the payment
 * ghost store) explicitly asks for the row whatever the listing state. An
 * order-level extra condition still applies. */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeIdSql: NumberedSql = () => "last_insert_rowid()",
  allowOverbook = false,
  extraCondition?: NumberedSql,
): SqlStatement => {
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
  return numberedStatement((bind) => {
    const listingIdSql = bind(listingId);
    const attendeeSql = attendeeIdSql(bind);
    const startAtSql = bind(startAt);
    const endAtSql = bind(endAt);
    const quantitySql = bind(quantity);
    const insertSelect = `INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id)
          SELECT ${listingIdSql}, ${attendeeSql}, ${startAtSql}, ${endAtSql}, ${quantitySql}, ${bind(orderToken)}, ${bind(parentListingId)}, ${bind(packageGroupId)}`;
    if (allowOverbook) {
      if (extraCondition === undefined) return insertSelect;
      return `${insertSelect}\n          WHERE ${extraCondition(bind)}`;
    }
    if (quantity === 0) {
      const exists = `EXISTS (SELECT 1 FROM listings AS listing WHERE listing.id = ${listingIdSql})`;
      if (extraCondition === undefined) {
        return `${insertSelect}\n          WHERE ${exists}`;
      }
      return `${insertSelect}\n          WHERE ${exists} AND (${extraCondition(bind)})`;
    }

    const capacity = buildCapacityCondition(
      listingId,
      quantity,
      date,
      undefined,
      durationDays,
    )(bind, { listingId: listingIdSql, quantity: quantitySql });
    const conditions =
      extraCondition === undefined
        ? capacity
        : `${capacity} AND (${extraCondition(bind)})`;
    return `${insertSelect}\n          WHERE ${conditions}`;
  });
};

/** Check several capacity conditions in one query. */
export const checkLinesCapacity = async (
  bookings: LineBooking[],
  excludeAttendeeId?: number,
): Promise<boolean[]> => {
  if (bookings.length === 0) return [];
  const conditions = bookings.map((booking) =>
    capacityConditionFor(booking, excludeAttendeeId),
  );
  const statement = numberedStatement((bind) => {
    const excludeAttendeeIdSql =
      excludeAttendeeId === undefined ? undefined : bind(excludeAttendeeId);
    const shared =
      excludeAttendeeIdSql === undefined
        ? {}
        : { excludeAttendeeId: excludeAttendeeIdSql };
    const columns = conditions
      .map((condition, index) => `(${condition(bind, shared)}) AS ok${index}`)
      .join(", ");
    return `SELECT ${columns}`;
  });
  const row = await requireOne<Record<string, number>>(
    statement.sql,
    statement.args,
  );
  return conditions.map((_, index) => row[`ok${index}`] === 1);
};

/** The listings whose lines do not fit right now, in one query. The
 * attendee-edit preflight names its culprit with this. */
export const unfitListingIds = async (
  bookings: LineBooking[],
  excludeAttendeeId?: number,
): Promise<number[]> => {
  const fits = await checkLinesCapacity(bookings, excludeAttendeeId);
  return unique(
    bookings.filter((_, index) => !fits[index]!).map((line) => line.listingId),
  );
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
): Map<number, CapacityBucket> => {
  const { items, listingsById, date } = context;
  const buckets = new Map<number, CapacityBucket>();
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
  return await fitsThrough(requireOne)({ groupDemand, listingDemand });
};

/** Ask one cart demand's fit through one required-row read. The checkout
 * preflight reads on the default route through this. */
const fitsThrough =
  (read: <T>(sql: string, args: InValue[]) => Promise<T>) =>
  async (demand: CartDemand): Promise<boolean> => {
    const { sql, args } = buildCartCapacitySql(demand);
    const row = await read<{ fits: number }>(sql, args);
    return row.fits === 1;
  };
