/**
 * Capacity checks and availability queries for attendees/listing_attendees.
 *
 * Multi-day daily bookings are enforced via per-day expansion: every day in
 * `[start, start + duration_days)` must independently pass listing + group caps.
 * This file contains the JS preflight (`checkListingAvailability`,
 * `checkBatchAvailabilityImpl`) — the inline SQL safety net lives in
 * `#shared/db/capacity.ts` and runs in the same statement as the INSERT/UPDATE.
 */

import type { InValue } from "@libsql/client";
import { filter, map, pipe, reduce, unique } from "#fp";
import { addDays } from "#shared/dates.ts";
import type {
  BatchAvailabilityItem,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import {
  buildCapacityCondition,
  buildGroupAttendeePredicate,
  dateToRange,
} from "#shared/db/capacity.ts";
import { inPlaceholders, queryAll, queryOne } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { type ListingType, normalizeDurationDays } from "#shared/types.ts";

/** Convert nullable date to start_at/end_at (null-safe wrapper around dateToRange) */
export const dateToStartEnd = (
  date: string | null,
  durationDays = 1,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { endAt: null, startAt: null };
  const range = dateToRange(date, durationDays);
  return { endAt: range.endAt, startAt: range.startAt };
};

type RemainingMap = Map<number, number>;

/**
 * Per-group remaining capacity. Groups with `max_attendees <= 0` (no cap)
 * are omitted from the map. With `date = null`, daily-listing attendees count
 * cumulatively — correct for booking-time enforcement after upstream date
 * validation, misleading for display.
 *
 * Optional `excludeAttendeeId` skips rows belonging to that attendee so an
 * admin moving their own booking doesn't fight themselves.
 */
export const getGroupRemainingByGroupId = async (
  groupIds: number[],
  date: string | null = null,
): Promise<RemainingMap> => {
  const ids = unique(groupIds.filter((id) => id > 0));
  if (ids.length === 0) return new Map();
  const predicate = buildGroupAttendeePredicate("e", "ea", date);
  const rows = await queryAll<{
    group_id: number;
    max_attendees: number;
    count: number;
  }>(
    `SELECT g.id as group_id, g.max_attendees,
            COALESCE(SUM(ea.quantity), 0) as count
     FROM groups g
     LEFT JOIN listings e ON e.group_id = g.id
     LEFT JOIN listing_attendees ea ON ea.listing_id = e.id
       AND ${predicate.sql}
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0
     GROUP BY g.id`,
    [...predicate.args, ...ids],
  );
  return new Map(
    rows.map((r) => [r.group_id, Math.max(0, r.max_attendees - r.count)]),
  );
};

type ListingForGroupLookup = {
  id: number;
  group_id: number;
  listing_type: ListingType;
};

/**
 * Per-listing view of group remaining capacity. Daily listings are dropped when
 * `date` is null — their cap is per-date, so a cumulative count would
 * misreport spots that other dates still have.
 */
export const getGroupRemainingByListingId = async (
  listings: ListingForGroupLookup[],
  date: string | null = null,
): Promise<RemainingMap> => {
  const candidates = date
    ? listings
    : listings.filter((e) => e.listing_type !== "daily");
  const groupMap = await getGroupRemainingByGroupId(
    candidates.map((e) => e.group_id),
    date,
  );
  const result: RemainingMap = new Map();
  for (const listing of candidates) {
    const remaining = groupMap.get(listing.group_id);
    if (remaining !== undefined) result.set(listing.id, remaining);
  }
  return result;
};

/** Returns `undefined` when no group cap applies: ungrouped, uncapped
 * group, or daily listing without a `date`. */
export const getGroupRemainingForListing = async (
  listing: ListingForGroupLookup,
  date: string | null = null,
): Promise<number | undefined> => {
  const map = await getGroupRemainingByListingId([listing], date);
  return map.get(listing.id);
};

/**
 * Build a capacity-checked INSERT into listing_attendees.
 * @param attendeeIdExpr - SQL expression for attendee_id (e.g. "last_insert_rowid()" or "?")
 * @param attendeeIdArg - Argument for "?" expr, omit for last_insert_rowid()
 */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: number,
): { sql: string; args: InValue[] } => {
  const {
    listingId,
    quantity: qty = 1,
    pricePaid = 0,
    date = null,
    durationDays = 1,
  } = booking;
  const condition = buildCapacityCondition(
    listingId,
    qty,
    date,
    undefined,
    durationDays,
  );
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const args: InValue[] = [listingId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(startAt, endAt, qty, pricePaid, ...condition.args);

  return {
    args,
    sql: `INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, price_paid)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?
          WHERE ${condition.sql}`,
  };
};

// ---------------------------------------------------------------------------
// Per-day preflight helpers used by hasAvailableSpots. They mirror the per-day
// SQL safety net but in JS so we can self-exclude an attendee row cleanly.
//
// Per-day loads are computed by fetching every row overlapping the whole
// booking span ONCE and summing per-day in JS — one round trip instead of
// one per day, which matters because production talks to a remote libsql
// server where each query is a network hop.
// ---------------------------------------------------------------------------

/** Expand a daily-listing range into individual day strings. */
const expandDailyRange = (date: string, durationDays: number): string[] => {
  const duration = normalizeDurationDays(durationDays);
  return Array.from({ length: duration }, (_, i) => addDays(date, i));
};

/** Half-open [startAt, endAt) span covering a set of YYYY-MM-DD days. */
const daySpan = (days: string[]): { startAt: string; endAt: string } => {
  const sorted = [...days].sort();
  return {
    endAt: dateToRange(sorted[sorted.length - 1]!).endAt,
    startAt: `${sorted[0]!}T00:00:00Z`,
  };
};

/** A booking row's range + quantity. Ranges are never null here — the
 * fetch queries below only match rows via the overlap predicate, which
 * NULL ranges can never satisfy (mirroring the SQL safety net). */
type IntervalRow = { start_at: string; end_at: string; quantity: number };

/** Sum the quantity column of a set of rows */
const sumQuantity = reduce(
  (sum: number, row: { quantity: number }) => sum + row.quantity,
  0,
);

/** Curried day-overlap predicate. String comparison mirrors SQLite TEXT
 * comparison byte-for-byte, so this reproduces the SQL overlap predicate
 * `start_at < dayEnd AND end_at > dayStart` exactly. */
const overlapsDay = (day: string) => {
  const { startAt, endAt } = dateToRange(day);
  return (row: IntervalRow): boolean =>
    row.start_at < endAt && row.end_at > startAt;
};

/** Per-day quantity sums for the given days from pre-fetched rows. */
const perDayLoads = (
  rows: IntervalRow[],
  days: string[],
): Map<string, number> =>
  new Map(
    map((day: string): [string, number] => [
      day,
      pipe(filter(overlapsDay(day)), sumQuantity)(rows),
    ])(days),
  );

/** Fetch all of an listing's rows overlapping the span of `days` — one query
 * regardless of how many days the booking covers. */
const getOverlappingRows = (
  listingId: number,
  days: string[],
): Promise<IntervalRow[]> => {
  const { startAt, endAt } = daySpan(days);
  return queryAll<IntervalRow>(
    `SELECT start_at, end_at, quantity FROM listing_attendees
     WHERE listing_id = ? AND start_at < ? AND end_at > ?`,
    [listingId, endAt, startAt],
  );
};

/** A group's cap plus its load split into rows that count on every day
 * (non-daily listings) and per-day interval rows (daily bookings). */
type GroupSpanLoad = { cap: number; base: number; rows: IntervalRow[] };

/**
 * Group cap + occupancy rows for the span of `days` — two queries
 * regardless of duration. Returns null when the group has no cap, matching
 * `getGroupRemainingByGroupId` omitting uncapped groups from its map.
 */
const getGroupSpanLoad = async (
  groupId: number,
  days: string[],
): Promise<GroupSpanLoad | null> => {
  const cap = (await queryOne<{ cap: number }>(
    "SELECT COALESCE((SELECT max_attendees FROM groups WHERE id = ?), 0) as cap",
    [groupId],
  ))!.cap;
  if (cap <= 0) return null;
  const { startAt, endAt } = daySpan(days);
  const groupRows = await queryAll<IntervalRow & { listing_type: ListingType }>(
    `SELECT ea.start_at, ea.end_at, ea.quantity, e.listing_type
     FROM listing_attendees ea
     JOIN listings e ON e.id = ea.listing_id
     WHERE e.group_id = ? AND (e.listing_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
    [groupId, endAt, startAt],
  );
  const isDailyRow = (
    row: IntervalRow & { listing_type: ListingType },
  ): boolean => row.listing_type === "daily";
  return {
    base: pipe(
      filter(
        (row: IntervalRow & { listing_type: ListingType }) => !isDailyRow(row),
      ),
      sumQuantity,
    )(groupRows),
    cap,
    rows: filter(isDailyRow)(groupRows),
  };
};

/** Per-day group remaining for `days`, or null when no cap applies.
 * remaining(day) = max(0, cap - (base + dailyLoad(day))) — identical to
 * `getGroupRemainingByGroupId` evaluated for each day, in two queries. */
const getGroupRemainingPerDay = async (
  groupId: number,
  days: string[],
): Promise<Map<string, number> | null> => {
  const group = await getGroupSpanLoad(groupId, days);
  if (!group) return null;
  const loads = perDayLoads(group.rows, days);
  return new Map(
    map((day: string): [string, number] => [
      day,
      Math.max(0, group.cap - group.base - loads.get(day)!),
    ])(days),
  );
};

/**
 * Per-day availability check for a single-listing booking. Used by
 * `hasAvailableSpots` (public availability API) and as the preflight in
 * `checkBatchAvailability` (public booking flow).
 *
 * Does NOT self-exclude — admin edit paths skip this preflight and rely on
 * the atomic SQL guard (which does self-exclude via `buildCapacityCondition`).
 */
export const checkListingAvailability = async (
  listingId: number,
  quantity = 1,
  date?: string | null,
  durationDays = 1,
): Promise<boolean> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) return false;

  if (listing.listing_type !== "daily" || !date) {
    if (listing.attendee_count + quantity > listing.max_attendees) return false;
    if (listing.group_id <= 0) return true;
    const remaining = (
      await getGroupRemainingByGroupId([listing.group_id], null)
    ).get(listing.group_id);
    return remaining === undefined || quantity <= remaining;
  }

  const days = expandDailyRange(date, durationDays);
  const loads = perDayLoads(await getOverlappingRows(listingId, days), days);
  if (!days.every((day) => loads.get(day)! + quantity <= listing.max_attendees))
    return false;
  if (listing.group_id <= 0) return true;
  const remaining = await getGroupRemainingPerDay(listing.group_id, days);
  if (!remaining) return true;
  return days.every((day) => quantity <= remaining.get(day)!);
};

type ListingRow = {
  id: number;
  max_attendees: number;
  group_id: number;
  listing_type: ListingType;
  attendee_count: number;
};

type DemandBucket = { perDay: Map<string, number>; total: number };

/** The days a bucket demands, or null when its demand is total-only. */
const demandedDays = (bucket: DemandBucket): string[] | null =>
  bucket.perDay.size > 0 ? [...bucket.perDay.keys()] : null;

/**
 * Aggregate batch items into per-key demand buckets. The `keyOf(listing)`
 * callback selects which bucket each item contributes to (returning null
 * skips the item). Daily listings with a date contribute per-day; everything
 * else contributes to a single total per bucket.
 *
 * Used twice: once keyed by listing id (for listing-cap checks), once keyed by
 * group id (for group-cap checks).
 */
const aggregateDemand = <K>(
  ctx: BatchAvailabilityContext,
  keyOf: (ev: ListingRow) => K | null,
): Map<K, DemandBucket> => {
  const { items, listingsById, date } = ctx;
  const buckets = new Map<K, DemandBucket>();
  for (const item of items) {
    const ev = listingsById.get(item.listingId)!;
    const key = keyOf(ev);
    if (key === null) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { perDay: new Map(), total: 0 };
      buckets.set(key, bucket);
    }
    if (ev.listing_type === "daily" && date) {
      for (const day of expandDailyRange(date, item.durationDays ?? 1)) {
        bucket.perDay.set(day, (bucket.perDay.get(day) ?? 0) + item.quantity);
      }
    } else {
      bucket.total += item.quantity;
    }
  }
  return buckets;
};

/**
 * Shared inputs to a batch-capacity check: the items under test, the resolved
 * listing rows they reference, and the optional anchor date for daily listings.
 */
type BatchAvailabilityContext = {
  items: BatchAvailabilityItem[];
  listingsById: Map<number, ListingRow>;
  date: string | null | undefined;
};

/**
 * Walk each (key, bucket) pair in `demand`, awaiting `passes` and returning
 * false on the first failure. Centralizes the short-circuiting iteration that
 * listing-cap and group-cap checks both need.
 */
const everyBucketPasses = async <K>(
  demand: Map<K, DemandBucket>,
  passes: (key: K, bucket: DemandBucket) => Promise<boolean>,
): Promise<boolean> => {
  for (const [key, bucket] of demand) {
    if (!(await passes(key, bucket))) return false;
  }
  return true;
};

/**
 * Curried: given the listings lookup, build an async predicate that checks a
 * single listing's demand against its `max_attendees` — per-day for daily
 * listings, and as a total against existing bookings.
 */
const listingBucketPasses =
  (listingsById: Map<number, ListingRow>) =>
  async (listingId: number, bucket: DemandBucket): Promise<boolean> => {
    const ev = listingsById.get(listingId)!;
    const days = demandedDays(bucket);
    if (days) {
      const loads = perDayLoads(
        await getOverlappingRows(listingId, days),
        days,
      );
      const overCap = [...bucket.perDay].some(
        ([day, qty]) => loads.get(day)! + qty > ev.max_attendees,
      );
      if (overCap) return false;
    }
    if (bucket.total > 0 && ev.attendee_count + bucket.total > ev.max_attendees)
      return false;
    return true;
  };

/**
 * Async predicate: does a single group's demand fit within its remaining
 * capacity, both per-day across the requested days and as a total against the
 * group's baseline occupancy?
 */
const groupBucketPasses = async (
  groupId: number,
  bucket: DemandBucket,
): Promise<boolean> => {
  const days = demandedDays(bucket);
  if (days) {
    const remaining = await getGroupRemainingPerDay(groupId, days);
    const overCap =
      remaining &&
      [...bucket.perDay].some(
        ([day, qty]) => qty + bucket.total > remaining.get(day)!,
      );
    if (overCap) return false;
  } else if (bucket.total > 0) {
    // Pure non-daily demand against baseline group occupancy.
    const remaining = (await getGroupRemainingByGroupId([groupId], null)).get(
      groupId,
    );
    if (remaining !== undefined && bucket.total > remaining) return false;
  }
  return true;
};

/**
 * Aggregate demand for `ctx` by `keyOf`, then verify every resulting bucket
 * passes `bucketPasses`. The shared shape of the listing-cap and group-cap
 * checks (both follow this aggregate-then-verify pattern) lives here.
 */
const checkCaps = (
  ctx: BatchAvailabilityContext,
  keyOf: (ev: ListingRow) => number | null,
  bucketPasses: (key: number, bucket: DemandBucket) => Promise<boolean>,
): Promise<boolean> => {
  const demand = aggregateDemand(ctx, keyOf);
  return everyBucketPasses(demand, bucketPasses);
};

/**
 * Check availability for multiple listings in a single preflight pass.
 * For multi-day daily listings, expands each booking into per-day demand so
 * that every day in the range is checked independently. Group caps are
 * similarly evaluated per-day across all listings in each group.
 */
export const checkBatchAvailabilityImpl = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => {
  if (items.length === 0) return true;
  // Reject negative quantities outright — would otherwise offset positive
  // rows and bypass the cap. Form validation clamps upstream; defensive.
  if (items.some((i) => i.quantity < 0)) return false;
  const listingIds = map((i: BatchAvailabilityItem) => i.listingId)(items);

  const listingRows = await queryAll<ListingRow>(
    `SELECT e.id, e.max_attendees, e.group_id, e.listing_type,
            COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM listings e
     LEFT JOIN listing_attendees ea ON ea.listing_id = e.id
     WHERE e.id IN (${inPlaceholders(listingIds)})
     GROUP BY e.id`,
    listingIds,
  );
  const listingsById = new Map(listingRows.map((r) => [r.id, r]));

  // Every item must reference a known listing.
  if (items.some((i) => !listingsById.has(i.listingId))) return false;

  const ctx: BatchAvailabilityContext = { date, items, listingsById };
  // Per-listing caps: each listing's per-day and total demand within max_attendees.
  if (
    !(await checkCaps(ctx, (ev) => ev.id, listingBucketPasses(listingsById)))
  ) {
    return false;
  }
  // Group caps: each group's per-day and total demand within its remaining capacity.
  return checkCaps(
    ctx,
    (ev) => (ev.group_id > 0 ? ev.group_id : null),
    groupBucketPasses,
  );
};
