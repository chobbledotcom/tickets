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
import { and, type Expr, type Operand, valued } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import {
  type SqlStatement,
  sql,
  sqlCommas,
  sqlList,
  sqlName,
} from "#db/sql.ts";
import { insertInto, type NewValues } from "#db/write.ts";
import { identity, map, mapById, requiredMapValue, unique } from "#fp";
import { capacityDateFor } from "#shared/capacity-rules.ts";
import { dateToStartEnd } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** The plan columns a subscription row writes. An ordinary row writes none
 * and keeps the column defaults. */
const subscriptionPlanColumns = (
  plan: ListingBooking["subscription"],
): Partial<NewValues<"listing_attendees">> =>
  plan === undefined
    ? {}
    : {
        recurring_interval: plan.interval,
        recurring_price: plan.amount,
        recurring_tax: plan.tax,
        subscription_id: plan.id,
        subscription_status: plan.status,
      };

/** Build an INSERT into listing_attendees, capacity-checked by default. A
 * zero-quantity booking carries no capacity or active condition: it demands
 * no places, so it can land on a full or inactive listing too. By default it
 * still names a listing that must exist, because listing_attendees has no
 * foreign key. An overbook caller (the payment
 * ghost store) explicitly asks for the row whatever the listing state. An
 * order-level extra condition still applies. */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeId: Operand<number> = valued(sql`last_insert_rowid()`),
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
  const extra =
    extraCondition === undefined ? true : valued<boolean>(extraCondition);
  const conditions = [
    allowOverbook ? true : roomFor({ date, durationDays, listingId, quantity }),
    extra,
  ];
  return insertInto(
    tables.listing_attendees,
    {
      attendee_id: attendeeId,
      end_at: endAt,
      listing_id: listingId,
      order_token: orderToken,
      package_group_id: packageGroupId,
      parent_listing_id: parentListingId,
      quantity,
      start_at: startAt,
      ...subscriptionPlanColumns(booking.subscription),
    },
    conditions.every((condition) => condition === true)
      ? {}
      : { when: and(...conditions) },
  );
};

/** What the row of one booking needs before it lands: room on the listing,
 *  or for a booking of no places a listing that exists. */
const roomFor = (line: LineBooking): Expr<boolean> =>
  line.quantity === 0
    ? from(tables.listings).where({ id: line.listingId }).exists()
    : buildCapacityCondition(
        line.listingId,
        line.quantity,
        line.date,
        undefined,
        line.durationDays,
      );

/** A capacity check over the lines of one order. `excludeAttendeeId` names the
 *  attendee whose own lines do not count against the capacity. */
type LinesCheck<Answer> = (
  bookings: LineBooking[],
  excludeAttendeeId?: number,
) => Promise<Answer>;

/** Check several capacity conditions in one query. */
export const checkLinesCapacity: LinesCheck<boolean[]> = async (
  bookings,
  excludeAttendeeId,
) => {
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
export const unfitListingIds: LinesCheck<number[]> = async (
  bookings,
  excludeAttendeeId,
) => {
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
