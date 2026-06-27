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
import { filter, map, pipe, sumOf, unique } from "#fp";
import { addDays } from "#shared/dates.ts";
import type {
  BatchAvailabilityItem,
  LineBooking,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import { buildCapacityCondition, dateToRange } from "#shared/db/capacity.ts";
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

/** Distinct group ids worth a cap lookup — positive only (0 = ungrouped). */
const uniquePositiveGroupIds = (groupIds: number[]): number[] =>
  unique(groupIds.filter((id) => id > 0));

/**
 * Per-group remaining capacity. Groups with `max_attendees <= 0` (no cap)
 * are omitted from the map. With `date = null`, this uses each listing's
 * editable booked_quantity running total; with a date, non-daily listings still
 * use booked_quantity while daily listings count overlapping attendee rows.
 */
export const getGroupRemainingByGroupId = async (
  groupIds: number[],
  date: string | null = null,
): Promise<RemainingMap> => {
  const ids = uniquePositiveGroupIds(groupIds);
  if (ids.length === 0) return new Map();
  const range = date ? dateToRange(date) : null;
  const datedCount = date
    ? `COALESCE((
        SELECT SUM(listing.booked_quantity)
          FROM listings AS listing
         WHERE listing.group_id = g.id AND listing.listing_type != 'daily'
      ), 0) + COALESCE((
        SELECT SUM(ea.quantity)
          FROM listing_attendees ea
          JOIN listings AS listing ON listing.id = ea.listing_id
         WHERE listing.group_id = g.id
           AND listing.listing_type = 'daily'
           AND ea.start_at < ? AND ea.end_at > ?
      ), 0)`
    : `COALESCE((
        SELECT SUM(listing.booked_quantity)
          FROM listings AS listing
         WHERE listing.group_id = g.id
      ), 0)`;
  const countArgs = range ? [range.endAt, range.startAt] : [];
  const rows = await queryAll<{
    group_id: number;
    max_attendees: number;
    count: number;
  }>(
    `SELECT g.id as group_id, g.max_attendees,
            ${datedCount} as count
     FROM groups g
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0
     GROUP BY g.id`,
    [...countArgs, ...ids],
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

const listingForCapacity = async (
  listingOrId: ListingForGroupLookup | number,
): Promise<ListingForGroupLookup | null> =>
  typeof listingOrId === "number"
    ? await getListingWithCount(listingOrId)
    : listingOrId;

/** Returns `undefined` when no group cap applies: ungrouped, uncapped
 * group, or daily listing without a `date`. */
export function getGroupRemainingForListing(
  listing: ListingForGroupLookup,
  date?: string | null,
): Promise<number | undefined>;
export function getGroupRemainingForListing(
  listingId: number,
  date?: string | null,
): Promise<number | undefined>;
export async function getGroupRemainingForListing(
  listingOrId: ListingForGroupLookup | number,
  date: string | null = null,
): Promise<number | undefined> {
  const listing = await listingForCapacity(listingOrId);
  if (!listing) return undefined;
  const map = await getGroupRemainingByListingId([listing], date);
  return map.get(listing.id);
}

/**
 * Build an INSERT into listing_attendees, capacity-checked by default.
 * @param attendeeIdExpr - SQL expression for attendee_id (e.g. "last_insert_rowid()" or "?")
 * @param attendeeIdArg - Argument for "?" expr, omit for last_insert_rowid()
 * @param allowOverbook - when true the capacity WHERE is dropped so the row is
 *   inserted unconditionally (admin manual add/edit may deliberately overbook).
 */
export const buildCapacityCheckedInsert = (
  booking: ListingBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: number,
  allowOverbook = false,
): { sql: string; args: InValue[] } => {
  const {
    listingId,
    quantity: qty = 1,
    date = null,
    durationDays = 1,
    orderToken = "",
    parentListingId = 0,
  } = booking;
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const args: InValue[] = [listingId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(startAt, endAt, qty, orderToken, parentListingId);
  // price_paid is no longer stored — a booking row's amount paid projects from
  // its ledger sale leg (posted by the booking poster from booking.pricePaid).
  // The order token + parent listing still persist for the parent/child gate.
  const insertSelect = `INSERT INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?, ?`;
  if (allowOverbook) return { args, sql: insertSelect };

  const condition = buildCapacityCondition(
    listingId,
    qty,
    date,
    undefined,
    durationDays,
  );
  args.push(...condition.args);
  return { args, sql: `${insertSelect}\n          WHERE ${condition.sql}` };
};

// ---------------------------------------------------------------------------
// Per-day load helpers for the remaining-capacity lookup and batch preflight.
//
// Per-day loads are computed by fetching every row overlapping the whole
// booking span ONCE and summing per-day in JS — one round trip instead of
// one per day, which matters because production talks to a remote libsql
// server where each query is a network hop.
// ---------------------------------------------------------------------------

/** Expand a daily-listing range into individual day strings. */
export const expandDailyRange = (
  date: string,
  durationDays: number,
): string[] => {
  const duration = normalizeDurationDays(durationDays);
  return Array.from({ length: duration }, (_, i) => addDays(date, i));
};

/** Half-open [startAt, endAt) span covering a set of YYYY-MM-DD days. */
const daySpan = (days: string[]): { startAt: string; endAt: string } => {
  const sorted = days.toSorted();
  return {
    endAt: dateToRange(sorted.at(-1)!).endAt,
    startAt: `${sorted[0]!}T00:00:00Z`,
  };
};

/** A booking row's range + quantity. Ranges are never null here — the
 * fetch queries below only match rows via the overlap predicate, which
 * NULL ranges can never satisfy (mirroring the SQL safety net). */
type IntervalRow = { start_at: string; end_at: string; quantity: number };

/** Sum the quantity column of a set of rows */
const sumQuantity = sumOf((row: { quantity: number }) => row.quantity);

/** Curried day-overlap predicate. String comparison mirrors SQLite TEXT
 * comparison byte-for-byte, so this reproduces the SQL overlap predicate
 * `start_at < dayEnd AND end_at > dayStart` exactly. */
export const overlapsDay = (day: string) => {
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

/**
 * Per-day availability check for a single-listing booking. Used by
 * `hasAvailableSpots` (public availability API).
 *
 * The capacity rules — per-day for daily listings, cumulative total for
 * standard/date-less, plus group caps — live entirely in
 * `buildCapacityCondition`, the same SQL the atomic write uses, so the whole
 * check is one query (the listing lookup is a cache hit on the booking paths).
 * Does NOT self-exclude — admin edit paths rely on the atomic SQL guard instead.
 */
export const checkListingAvailability = async (
  listingId: number,
  quantity = 1,
  date?: string | null,
  durationDays = 1,
): Promise<boolean> => {
  const listing = await getListingWithCount(listingId);
  if (!listing) return false;
  // A standard listing's rows carry no booking range, so they'd never match a
  // date overlap — pass null to count them all as a cumulative total instead.
  const checkDate = listing.listing_type === "daily" ? (date ?? null) : null;
  return (
    await checkLinesCapacity([
      { date: checkDate, durationDays, listingId, quantity },
    ])
  )[0]!;
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

/** The keys of a demand map whose bucket has per-day (daily) demand. */
const withDailyDemand = (demand: Map<number, DemandBucket>): number[] =>
  [...demand].filter(([, b]) => b.perDay.size > 0).map(([key]) => key);

/** A single listing's demand fits its `max_attendees` — per-day against
 * pre-fetched occupancy, and total against the existing count. */
const listingFits = (
  ev: ListingRow,
  bucket: DemandBucket,
  overlapByListing: Map<number, IntervalRow[]>,
): boolean => {
  const days = demandedDays(bucket);
  if (days) {
    const loads = perDayLoads(overlapByListing.get(ev.id) ?? [], days);
    if (
      [...bucket.perDay].some(
        ([day, qty]) => loads.get(day)! + qty > ev.max_attendees,
      )
    ) {
      return false;
    }
  }
  return !(
    bucket.total > 0 && ev.attendee_count + bucket.total > ev.max_attendees
  );
};

/** A single group's demand fits its remaining capacity — per-day against
 * pre-fetched per-day remaining, total against the date-less baseline. */
const groupFits = (
  groupId: number,
  bucket: DemandBucket,
  groupPerDay: Map<number, Map<string, number>>,
  totalGroupRemaining: Map<number, number>,
): boolean => {
  const remaining = groupPerDay.get(groupId);
  if (
    remaining &&
    [...bucket.perDay].some(
      ([day, qty]) => qty + bucket.total > remaining.get(day)!,
    )
  ) {
    return false;
  }
  if (bucket.perDay.size === 0 && bucket.total > 0) {
    const groupRemaining = totalGroupRemaining.get(groupId);
    if (groupRemaining !== undefined && bucket.total > groupRemaining) {
      return false;
    }
  }
  return true;
};

/**
 * Check availability for multiple listings in a single preflight pass.
 * For multi-day daily listings, expands each booking into per-day demand so
 * that every day in the range is checked independently. Group caps are
 * similarly evaluated per-day across all listings in each group.
 *
 * Batched: per-listing occupancy and per-group caps are each fetched in one
 * query for the whole cart, so a large multi-listing cart can't fan out a read
 * per listing or per group.
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
    `SELECT listing.id, listing.max_attendees, listing.group_id, listing.listing_type,
            listing.booked_quantity as attendee_count
     FROM listings AS listing
     WHERE listing.id IN (${inPlaceholders(listingIds)})`,
    listingIds,
  );
  const listingsById = new Map(listingRows.map((r) => [r.id, r]));

  // Every item must reference a known listing.
  if (items.some((i) => !listingsById.has(i.listingId))) return false;

  const ctx: BatchAvailabilityContext = { date, items, listingsById };
  const listingDemand = aggregateDemand(ctx, (ev) => ev.id);
  const groupDemand = aggregateDemand(ctx, (ev) =>
    ev.group_id > 0 ? ev.group_id : null,
  );

  // Prefetch everything the per-bucket checks need, batched: per-listing
  // occupancy rows, per-group per-day remaining, and date-less group caps.
  const allDays = unique(
    [...listingDemand.values()].flatMap((b) => [...b.perDay.keys()]),
  );
  const [overlapByListing, groupPerDay, totalGroupRemaining] =
    await Promise.all([
      overlappingRowsByListing(withDailyDemand(listingDemand), allDays),
      groupPerDayRemainingByGroup(withDailyDemand(groupDemand), allDays),
      getGroupRemainingByGroupId(
        [...groupDemand]
          .filter(([, b]) => b.perDay.size === 0 && b.total > 0)
          .map(([gid]) => gid),
        null,
      ),
    ]);

  for (const [id, bucket] of listingDemand) {
    if (!listingFits(listingsById.get(id)!, bucket, overlapByListing)) {
      return false;
    }
  }
  for (const [gid, bucket] of groupDemand) {
    if (!groupFits(gid, bucket, groupPerDay, totalGroupRemaining)) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Remaining-capacity lookup (display + overbooking warnings)
// ---------------------------------------------------------------------------

/** A listing's identity + the capacity inputs a remaining-units lookup needs —
 * the same shape the batch check uses. `ListingWithCount` satisfies it. */
export type ListingCapacityRow = ListingRow;

/** All overlapping interval rows for several listings in one query, grouped by
 * listing id — so per-day loads come from one round trip, not one per listing. */
const overlappingRowsByListing = async (
  listingIds: number[],
  days: string[],
): Promise<Map<number, IntervalRow[]>> => {
  const byListing = new Map<number, IntervalRow[]>();
  if (listingIds.length === 0) return byListing;
  const { startAt, endAt } = daySpan(days);
  const rows = await queryAll<IntervalRow & { listing_id: number }>(
    `SELECT listing_id, start_at, end_at, quantity FROM listing_attendees
     WHERE listing_id IN (${inPlaceholders(
       listingIds,
     )}) AND start_at < ? AND end_at > ?`,
    [...listingIds, endAt, startAt],
  );
  for (const row of rows) {
    const list = byListing.get(row.listing_id);
    if (list) list.push(row);
    else byListing.set(row.listing_id, [row]);
  }
  return byListing;
};

/** Per-day group remaining for several groups in two queries (caps + occupancy
 * rows), keyed by group id. Uncapped/absent groups are omitted, matching
 * `getGroupRemainingByGroupId`. */
const groupPerDayRemainingByGroup = async (
  groupIds: number[],
  days: string[],
): Promise<Map<number, Map<string, number>>> => {
  const result = new Map<number, Map<string, number>>();
  const ids = uniquePositiveGroupIds(groupIds);
  if (ids.length === 0) return result;
  const caps = await queryAll<{
    id: number;
    max_attendees: number;
    base: number;
  }>(
    `SELECT g.id, g.max_attendees,
            COALESCE((
              SELECT SUM(listing.booked_quantity)
                FROM listings AS listing
               WHERE listing.group_id = g.id AND listing.listing_type != 'daily'
            ), 0) AS base
       FROM groups g
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0`,
    ids,
  );
  if (caps.length === 0) return result;
  const cappedIds = caps.map((c) => c.id);
  const { startAt, endAt } = daySpan(days);
  type GroupRow = IntervalRow & { group_id: number };
  const rows = await queryAll<GroupRow>(
    `SELECT listing.group_id, ea.start_at, ea.end_at, ea.quantity
     FROM listing_attendees ea
     JOIN listings AS listing ON listing.id = ea.listing_id
     WHERE listing.group_id IN (${inPlaceholders(cappedIds)})
       AND listing.listing_type = 'daily'
       AND ea.start_at < ? AND ea.end_at > ?`,
    [...cappedIds, endAt, startAt],
  );
  const rowsByGroup = new Map<number, GroupRow[]>();
  for (const row of rows) {
    const list = rowsByGroup.get(row.group_id);
    if (list) list.push(row);
    else rowsByGroup.set(row.group_id, [row]);
  }
  for (const { id, max_attendees, base } of caps) {
    const groupRows = rowsByGroup.get(id) ?? [];
    const loads = perDayLoads(groupRows, days);
    result.set(
      id,
      new Map(days.map((day) => [day, max_attendees - base - loads.get(day)!])),
    );
  }
  return result;
};

/**
 * Remaining bookable units per listing for an anchor date + duration, as a
 * `Map<listingId, number>` (clamped at 0).
 *
 * The read-side mirror of the booking-time caps in `checkListingAvailability`:
 * same per-day expansion and group-cap rules, returning the count for display
 * ("X/Y remaining") and overbooking warnings. Daily listings (with a date) are
 * evaluated per day and report the tightest day; standard listings — and every
 * listing when `date` is null — use their cumulative totals.
 *
 * Batched into a constant ≤4 queries regardless of how many listings are passed,
 * so a large catalogue can't blow the per-request query budget.
 */
const getListingRemainingMapForRange = async (
  listings: ListingCapacityRow[],
  date: string | null,
  durationDays = 1,
): Promise<Map<number, number>> => {
  const usesRange = (l: ListingCapacityRow): boolean =>
    l.listing_type === "daily" && date !== null;
  const daily = filter(usesRange)(listings);
  const totals = filter((l: ListingCapacityRow) => !usesRange(l))(listings);
  const days = date ? expandDailyRange(date, durationDays) : [];

  const [totalGroupRemaining, overlapByListing, dailyGroupPerDay] =
    await Promise.all([
      getGroupRemainingByGroupId(
        totals.map((l) => l.group_id),
        null,
      ),
      overlappingRowsByListing(
        daily.map((l) => l.id),
        days,
      ),
      groupPerDayRemainingByGroup(
        daily.map((l) => l.group_id),
        days,
      ),
    ]);

  const result = new Map<number, number>();
  for (const l of totals) {
    const base = l.max_attendees - l.attendee_count;
    const group =
      l.group_id > 0 ? totalGroupRemaining.get(l.group_id) : undefined;
    result.set(l.id, group === undefined ? base : Math.min(base, group));
  }
  for (const l of daily) {
    const loads = perDayLoads(overlapByListing.get(l.id) ?? [], days);
    const listingRemaining = Math.min(
      ...days.map((day) => l.max_attendees - loads.get(day)!),
    );
    const groupPerDay = dailyGroupPerDay.get(l.group_id);
    const remaining = groupPerDay
      ? Math.min(
          listingRemaining,
          Math.min(...days.map((day) => groupPerDay.get(day)!)),
        )
      : listingRemaining;
    result.set(l.id, remaining);
  }
  return result;
};

export function getListingRemainingForRange(
  listings: ListingCapacityRow[],
  date: string | null,
  durationDays?: number,
): Promise<Map<number, number>>;
export function getListingRemainingForRange(
  listingId: number,
  date: string | null,
  durationDays?: number,
): Promise<number | undefined>;
export async function getListingRemainingForRange(
  listingsOrId: ListingCapacityRow[] | number,
  date: string | null,
  durationDays = 1,
): Promise<Map<number, number> | number | undefined> {
  if (typeof listingsOrId !== "number") {
    return getListingRemainingMapForRange(listingsOrId, date, durationDays);
  }
  const listing = await getListingWithCount(listingsOrId);
  if (!listing) return undefined;
  const remaining = await getListingRemainingMapForRange(
    [listing],
    date,
    durationDays,
  );
  return remaining.get(listingsOrId);
}

/**
 * Batched capacity check: whether each booking fits, in a single query. The
 * per-booking self-excluding conditions (the same ones the atomic write uses)
 * become separate columns of one SELECT, so N lines cost one round trip instead
 * of N. Pass `excludeAttendeeId` to ignore that attendee's own rows, so an
 * unchanged edit doesn't count against itself. Drives the admin overbooking
 * warning and the edit preflight; the save itself is allowed to overbook.
 */
export const checkLinesCapacity = async (
  bookings: LineBooking[],
  excludeAttendeeId?: number,
): Promise<boolean[]> => {
  if (bookings.length === 0) return [];
  const conditions = bookings.map((b) =>
    buildCapacityCondition(
      b.listingId,
      b.quantity,
      b.date,
      excludeAttendeeId,
      b.durationDays,
    ),
  );
  const columns = conditions.map((c, i) => `(${c.sql}) AS ok${i}`).join(", ");
  const args = conditions.flatMap((c) => c.args);
  const row = (await queryOne<Record<string, number>>(
    `SELECT ${columns}`,
    args,
  ))!;
  return conditions.map((_, i) => row[`ok${i}`] === 1);
};
