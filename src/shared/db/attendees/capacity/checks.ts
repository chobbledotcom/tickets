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
import { queryAll, requireOne } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { runWithPrimaryReads } from "#db/primary-reads.ts";
import { sql, sqlCommas, sqlList, sqlName, type SqlSlot, type SqlStatement } from "#db/sql.ts";
import { identity, map, mapById, requiredMapValue, unique } from "#fp";
import { capacityDateFor } from "#shared/capacity-rules.ts";
import { dateToStartEnd } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Build an INSERT into listing_attendees, capacity-checked by default. A
 * zero-quantity booking carries no capacity or active condition: it demands
 * no places, so it can land on a full or inactive listing too. By default it
 * still names a listing that must exist, because listing_attendees has no
 * foreign key. An overbook caller (the payment
 * ghost store) explicitly asks for the row whatever the listing state. An
 * order-level extra condition still applies. */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeId: SqlSlot = sql`last_insert_rowid()`,
  allowOverbook = false,
  extraCondition?: SqlStatement,
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
  const insertSelect = sql`INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id)
          SELECT ${listingId}, ${attendeeId}, ${startAt}, ${endAt}, ${quantity}, ${orderToken}, ${parentListingId}, ${packageGroupId}`;
  const guardedBy = (condition: SqlStatement): SqlStatement =>
    sql`${insertSelect}\n          WHERE ${
      extraCondition === undefined
        ? condition
        : sql`${condition} AND (${extraCondition})`
    }`;
  if (allowOverbook) {
    return extraCondition === undefined
      ? insertSelect
      : sql`${insertSelect}\n          WHERE ${extraCondition}`;
  }
  if (quantity === 0) {
    return guardedBy(
      sql`EXISTS (SELECT 1 FROM listings AS listing WHERE listing.id = ${listingId})`,
    );
  }
  return guardedBy(
    buildCapacityCondition(listingId, quantity, date, undefined, durationDays),
  );
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
  const columns = sqlCommas(
    conditions.map(
      (condition, index) => sql`(${condition}) AS ${sqlName(`ok${index}`)}`,
    ),
  );
  const row = await requireOne<Record<string, number>>(sql`SELECT ${columns}`);
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
    const listing = requiredMapValue(
      listingsById,
      item.listingId,
      `Listing ${item.listingId} missing`,
    );
    for (const key of keysFor(listing, item)) {
      addDemandToBucket(getOrCreateBucket(buckets, key), listing, item, date);
    }
  }
  return buckets;
};

/** Check a whole booking batch in one preflight query. Every read pins to
 * the primary. Production callers treat `false` as final, so a replica that
 * has not replayed a cancellation yet must not reject an order that fits.
 * The guarded write still catches the opposite error, so no oversell is
 * possible either way. */
export const checkBatchAvailabilityImpl = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> =>
  runWithPrimaryReads(async () => {
    if (items.length === 0) return true;
    if (items.some((item) => item.quantity < 0)) return false;
    const listingIds = map((item: BatchAvailabilityItem) => item.listingId)(
      items,
    );
    const listingRows = await queryAll<ListingCapacityRow>(
      sql`SELECT listing.id, listing.max_attendees, listing.listing_type,
            listing.booked_quantity as attendee_count
       FROM listings AS listing
      WHERE listing.id IN (${sqlList(listingIds)})`,
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
  });

/** Ask one cart demand's fit through one required-row read. The checkout
 * preflight runs under the primary-read scope, so this read lands on the
 * primary with the rest of the preflight. */
const fitsThrough =
  (read: <T>(statement: SqlStatement) => Promise<T>) =>
  async (demand: CartDemand): Promise<boolean> => {
    const row = await read<{ fits: number }>(buildCartCapacitySql(demand));
    return row.fits === 1;
  };
