import type {
  BatchAvailabilityItem,
  LineBooking,
  ListingBooking,
} from "#db/attendee-types.ts";
import {
  buildBatchCapacitySql,
  buildCapacityCondition,
  buildManyFitsSql,
  type CapacityBucket,
  type CartDemand,
  capacityConditionFor,
} from "#db/capacity.ts";
import {
  inPlaceholders,
  queryAll,
  queryBatchPrimary,
  requireOne,
  resultRows,
  type SqlStatement,
} from "#db/client.ts";
import { listingGroups } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { type NumberedSql, numberedStatement } from "#db/numbered-statement.ts";
import { compact, identity, map, mapById, requiredMapValue, unique } from "#fp";
import { capacityDateFor, countsPerDate } from "#shared/capacity-rules.ts";
import { requireValue } from "#shared/required-value.ts";
import { dateToStartEnd, expandDailyRange } from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Build an INSERT into listing_attendees, capacity-checked by default. */
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
    if (allowOverbook) return insertSelect;

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
  listing: Pick<ListingCapacityRow, "listing_type">,
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

type LineListingFacts = {
  groupIds: number[];
  listing_type: ListingCapacityRow["listing_type"];
};

/** One cart demand for a slice of lines, each line counted on its own date. */
const linesDemand = (
  lines: LineBooking[],
  factsById: Map<number, LineListingFacts>,
): CartDemand => {
  const demand: CartDemand = {
    groupDemand: new Map(),
    listingDemand: new Map(),
  };
  for (const line of lines) {
    const facts = requiredMapValue(
      factsById,
      line.listingId,
      `Listing ${line.listingId} was not read for the refusal diagnosis`,
    );
    const item = {
      durationDays: line.durationDays,
      listingId: line.listingId,
      quantity: line.quantity,
    };
    addDemandToBucket(
      getOrCreateBucket(demand.listingDemand, line.listingId),
      facts,
      item,
      line.date,
    );
    for (const groupId of facts.groupIds) {
      addDemandToBucket(
        getOrCreateBucket(demand.groupDemand, groupId),
        facts,
        item,
        line.date,
      );
    }
  }
  return demand;
};

/** One primary round trip answering whether each cart demand fits. */
const manyFitsOnPrimary = async (demands: CartDemand[]): Promise<boolean[]> => {
  const { sql, args } = buildManyFitsSql(demands);
  const [result] = await queryBatchPrimary([{ args, sql }]);
  const row = requireValue(
    resultRows<Record<string, number>>(result!)[0],
    "The fits query returned no row",
  );
  return demands.map((_, index) => row[`fit${index}`] === 1);
};

/** Each prefix of the order is asked as one cumulative demand, so the first
 * line that does not fit on top of its predecessors is the one named. A shared
 * group limit counts.
 *
 * Prefix fits only shrink as lines are added, so a binary search finds the
 * first unfit prefix. The probe count grows with the logarithm of the order,
 * and no probe's SQL is bigger than the whole-order preflight's.
 *
 * The reads run on the primary because the refused write did. A replica can lag
 * behind the booking that took the last place, and the isolate's caches can
 * hold a listing another isolate deleted. */
export const refusedOrderUnfitListingIds = async (
  lines: LineBooking[],
): Promise<number[]> => {
  const listingIds = unique(lines.map((line) => line.listingId));
  const [listingResult, memberResult] = await queryBatchPrimary([
    {
      args: listingIds,
      sql: `SELECT listing.id, listing.listing_type
              FROM listings AS listing
             WHERE listing.id IN (${inPlaceholders(listingIds)})`,
    },
    {
      args: listingIds,
      sql: `SELECT groupListing.listing_id, groupListing.group_id
              FROM group_listings AS groupListing
             WHERE groupListing.listing_id IN (${inPlaceholders(listingIds)})`,
    },
  ]);
  const factsById = new Map<number, LineListingFacts>(
    resultRows<Pick<ListingCapacityRow, "id" | "listing_type">>(
      listingResult!,
    ).map((row) => [row.id, { groupIds: [], listing_type: row.listing_type }]),
  );
  if (listingIds.some((id) => !factsById.has(id))) return [];
  for (const row of resultRows<{ group_id: number; listing_id: number }>(
    memberResult!,
  )) {
    requiredMapValue(
      factsById,
      row.listing_id,
      `Group membership row for an unrequested listing ${row.listing_id}`,
    ).groupIds.push(row.group_id);
  }

  const days = unique(compact(lines.map((line) => line.date)));
  if (days.length > 1) {
    const fits = await manyFitsOnPrimary(
      lines.map((line) => linesDemand([line], factsById)),
    );
    return unique(
      lines.filter((_, index) => !fits[index]).map((line) => line.listingId),
    );
  }
  const onDay = lines.map((line) => ({ ...line, date: days[0] ?? null }));
  const prefixFits = async (length: number): Promise<boolean> =>
    (
      await manyFitsOnPrimary([linesDemand(onDay.slice(0, length), factsById)])
    )[0]!;
  // A race that freed the room again before this read names no listing.
  if (await prefixFits(onDay.length)) return [];
  let shortestUnfit = onDay.length;
  let longestFit = 0;
  // Halving needs fewer steps than the order has lines, so the step bound
  // never cuts the search short — it only keeps the loop finite.
  for (let step = 0; step < onDay.length; step++) {
    if (longestFit + 1 >= shortestUnfit) break;
    const middle = Math.floor((longestFit + shortestUnfit) / 2);
    if (await prefixFits(middle)) longestFit = middle;
    else shortestUnfit = middle;
  }
  return [lines[shortestUnfit - 1]!.listingId];
};
