/**
 * Capacity checks and availability queries for attendees/event_attendees.
 *
 * Multi-day daily bookings are enforced via per-day expansion: every day in
 * `[start, start + duration_days)` must independently pass event + group caps.
 * This file contains the JS preflight (`checkEventAvailability`,
 * `checkBatchAvailabilityImpl`) — the inline SQL safety net lives in
 * `#shared/db/capacity.ts` and runs in the same statement as the INSERT/UPDATE.
 */

import type { InValue } from "@libsql/client";
import { unique } from "#fp";
import { addDays } from "#shared/dates.ts";
import type {
  BatchAvailabilityItem,
  EventBooking,
  UpdateEventLinkResult,
} from "#shared/db/attendee-types.ts";
import {
  buildCapacityCondition,
  buildGroupAttendeePredicate,
  dateToRange,
} from "#shared/db/capacity.ts";
import { inPlaceholders, queryAll, queryOne } from "#shared/db/client.ts";
import { getEventWithCount, invalidateEventsCache } from "#shared/db/events.ts";
import type { EventType } from "#shared/types.ts";

/** Shared failure result for capacity-exceeded */
export const CAPACITY_EXCEEDED = {
  reason: "capacity_exceeded" as const,
  success: false as const,
};

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
 * are omitted from the map. With `date = null`, daily-event attendees count
 * cumulatively — correct for booking-time enforcement after upstream date
 * validation, misleading for display.
 *
 * Optional `excludeAttendeeId` skips rows belonging to that attendee so an
 * admin moving their own booking doesn't fight themselves.
 */
export const getGroupRemainingByGroupId = async (
  groupIds: number[],
  date: string | null = null,
  excludeAttendeeId?: number,
): Promise<RemainingMap> => {
  const ids = unique(groupIds.filter((id) => id > 0));
  if (ids.length === 0) return new Map();
  const predicate = buildGroupAttendeePredicate("e", "ea", date);
  const excludeClause = excludeAttendeeId ? "AND ea.attendee_id != ?" : "";
  const excludeArgs: InValue[] = excludeAttendeeId ? [excludeAttendeeId] : [];
  const rows = await queryAll<{
    group_id: number;
    max_attendees: number;
    count: number;
  }>(
    `SELECT g.id as group_id, g.max_attendees,
            COALESCE(SUM(ea.quantity), 0) as count
     FROM groups g
     LEFT JOIN events e ON e.group_id = g.id
     LEFT JOIN event_attendees ea ON ea.event_id = e.id
       ${excludeClause}
       AND ${predicate.sql}
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0
     GROUP BY g.id`,
    [...excludeArgs, ...predicate.args, ...ids],
  );
  return new Map(
    rows.map((r) => [r.group_id, Math.max(0, r.max_attendees - r.count)]),
  );
};

type EventForGroupLookup = {
  id: number;
  group_id: number;
  event_type: EventType;
};

/**
 * Per-event view of group remaining capacity. Daily events are dropped when
 * `date` is null — their cap is per-date, so a cumulative count would
 * misreport spots that other dates still have.
 */
export const getGroupRemainingByEventId = async (
  events: EventForGroupLookup[],
  date: string | null = null,
): Promise<RemainingMap> => {
  const candidates = date
    ? events
    : events.filter((e) => e.event_type !== "daily");
  const groupMap = await getGroupRemainingByGroupId(
    candidates.map((e) => e.group_id),
    date,
  );
  const result: RemainingMap = new Map();
  for (const event of candidates) {
    const remaining = groupMap.get(event.group_id);
    if (remaining !== undefined) result.set(event.id, remaining);
  }
  return result;
};

/** Returns `undefined` when no group cap applies: ungrouped, uncapped
 * group, or daily event without a `date`. */
export const getGroupRemainingForEvent = async (
  event: EventForGroupLookup,
  date: string | null = null,
): Promise<number | undefined> => {
  const map = await getGroupRemainingByEventId([event], date);
  return map.get(event.id);
};

/**
 * Build a capacity-checked INSERT into event_attendees.
 * @param attendeeIdExpr - SQL expression for attendee_id (e.g. "last_insert_rowid()" or "?")
 * @param attendeeIdArg - Argument for "?" expr, omit for last_insert_rowid()
 */
export const buildCapacityCheckedInsert = (
  booking: EventBooking,
  attendeeIdExpr = "last_insert_rowid()",
  attendeeIdArg?: number,
): { sql: string; args: InValue[] } => {
  const {
    eventId,
    quantity: qty = 1,
    pricePaid = 0,
    date = null,
    durationDays = 1,
  } = booking;
  const condition = buildCapacityCondition(
    eventId,
    qty,
    date,
    undefined,
    durationDays,
  );
  const { startAt, endAt } = dateToStartEnd(date, durationDays);
  const args: InValue[] = [eventId];
  if (attendeeIdArg !== undefined) args.push(attendeeIdArg);
  args.push(startAt, endAt, qty, pricePaid, ...condition.args);

  return {
    args,
    sql: `INSERT INTO event_attendees (event_id, attendee_id, start_at, end_at, quantity, price_paid)
          SELECT ?, ${attendeeIdExpr}, ?, ?, ?, ?
          WHERE ${condition.sql}`,
  };
};

/** Check a capacity-guarded write result and invalidate cache on success */
export const checkCapacityResult = (result: {
  rowsAffected: number;
}): UpdateEventLinkResult => {
  if (!result.rowsAffected) return CAPACITY_EXCEEDED;
  invalidateEventsCache();
  return { success: true };
};

// ---------------------------------------------------------------------------
// Per-day preflight helpers used by hasAvailableSpots / addEventLink /
// updateEventLink. They mirror the per-day SQL safety net but in JS so we
// can self-exclude an attendee row cleanly.
//
// Per-day loads are computed by fetching every row overlapping the whole
// booking span ONCE and summing per-day in JS — one round trip instead of
// one per day, which matters because production talks to a remote libsql
// server where each query is a network hop.
// ---------------------------------------------------------------------------

/** Expand a daily-event range into individual day strings.
 * Clamps duration to >= 1 to defend against bogus 0/negative inputs. */
const expandDailyRange = (date: string, durationDays: number): string[] => {
  const duration = Math.max(1, Math.floor(durationDays));
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

/**
 * Per-day quantity sums for the given days from pre-fetched rows.
 * String comparison mirrors SQLite TEXT comparison byte-for-byte, so this
 * reproduces the SQL overlap predicate `start_at < dayEnd AND end_at >
 * dayStart` exactly.
 */
const perDayLoads = (
  rows: IntervalRow[],
  days: string[],
): Map<string, number> => {
  const loads = new Map<string, number>();
  for (const day of days) {
    const { startAt, endAt } = dateToRange(day);
    let sum = 0;
    for (const row of rows) {
      if (row.start_at < endAt && row.end_at > startAt) sum += row.quantity;
    }
    loads.set(day, sum);
  }
  return loads;
};

/** Fetch all of an event's rows overlapping the span of `days` — one query
 * regardless of how many days the booking covers. */
const getOverlappingRows = async (
  eventId: number,
  days: string[],
  excludeAttendeeId?: number,
): Promise<IntervalRow[]> => {
  const { startAt, endAt } = daySpan(days);
  const exclude = excludeAttendeeId ? "AND attendee_id != ? " : "";
  const args: InValue[] = excludeAttendeeId
    ? [eventId, excludeAttendeeId, endAt, startAt]
    : [eventId, endAt, startAt];
  return queryAll<IntervalRow>(
    `SELECT start_at, end_at, quantity FROM event_attendees
     WHERE event_id = ? ${exclude}AND start_at < ? AND end_at > ?`,
    args,
  );
};

/** A group's cap plus its load split into rows that count on every day
 * (non-daily events) and per-day interval rows (daily bookings). */
type GroupSpanLoad = { cap: number; base: number; rows: IntervalRow[] };

/**
 * Group cap + occupancy rows for the span of `days` — two queries
 * regardless of duration. Returns null when the group has no cap, matching
 * `getGroupRemainingByGroupId` omitting uncapped groups from its map.
 */
const getGroupSpanLoad = async (
  groupId: number,
  days: string[],
  excludeAttendeeId?: number,
): Promise<GroupSpanLoad | null> => {
  const cap = (await queryOne<{ cap: number }>(
    "SELECT COALESCE((SELECT max_attendees FROM groups WHERE id = ?), 0) as cap",
    [groupId],
  ))!.cap;
  if (cap <= 0) return null;
  const { startAt, endAt } = daySpan(days);
  const exclude = excludeAttendeeId ? "AND ea.attendee_id != ? " : "";
  const args: InValue[] = excludeAttendeeId
    ? [groupId, excludeAttendeeId, endAt, startAt]
    : [groupId, endAt, startAt];
  const groupRows = await queryAll<IntervalRow & { event_type: EventType }>(
    `SELECT ea.start_at, ea.end_at, ea.quantity, e.event_type
     FROM event_attendees ea
     JOIN events e ON e.id = ea.event_id
     WHERE e.group_id = ? ${exclude}AND (e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
    args,
  );
  let base = 0;
  const rows: IntervalRow[] = [];
  for (const row of groupRows) {
    if (row.event_type !== "daily") base += row.quantity;
    else rows.push(row);
  }
  return { base, cap, rows };
};

/** Per-day group remaining for `days`, or null when no cap applies.
 * remaining(day) = max(0, cap - (base + dailyLoad(day))) — identical to
 * `getGroupRemainingByGroupId` evaluated for each day, in two queries. */
const getGroupRemainingPerDay = async (
  groupId: number,
  days: string[],
  excludeAttendeeId?: number,
): Promise<Map<string, number> | null> => {
  const group = await getGroupSpanLoad(groupId, days, excludeAttendeeId);
  if (!group) return null;
  const loads = perDayLoads(group.rows, days);
  const remaining = new Map<string, number>();
  for (const day of days) {
    remaining.set(day, Math.max(0, group.cap - group.base - loads.get(day)!));
  }
  return remaining;
};

/** Cumulative event load for date-less checks, optionally excluding one
 * attendee's rows (the cached count can't subtract a single attendee). */
const datelessLoad = async (
  eventId: number,
  excludeAttendeeId: number | undefined,
  attendeeCount: number,
): Promise<number> => {
  if (!excludeAttendeeId) return attendeeCount;
  return (await queryOne<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND attendee_id != ?",
    [eventId, excludeAttendeeId],
  ))!.count;
};

/**
 * Accurate per-day availability check for a single-event booking, shared by
 * `hasAvailableSpots`, `addEventLink`, and `updateEventLink`.
 *
 * Checks every day in `[date, date + durationDays)` against event + group
 * caps using one overlap fetch per scope. The atomic SQL still runs its own
 * WHERE-guarded check as a race-free safety net; this preflight ensures we
 * don't false-reject multi-day ranges with non-overlapping existing bookings.
 */
export const checkEventAvailability = async (
  eventId: number,
  quantity: number,
  date: string | null | undefined,
  excludeAttendeeId?: number,
  durationDays = 1,
): Promise<boolean> => {
  const event = await getEventWithCount(eventId);
  if (!event) return false;

  if (event.event_type !== "daily" || !date) {
    const load = await datelessLoad(
      eventId,
      excludeAttendeeId,
      event.attendee_count,
    );
    if (load + quantity > event.max_attendees) return false;
    if (event.group_id <= 0) return true;
    const remaining = (
      await getGroupRemainingByGroupId(
        [event.group_id],
        null,
        excludeAttendeeId,
      )
    ).get(event.group_id);
    return remaining === undefined || quantity <= remaining;
  }

  const days = expandDailyRange(date, durationDays);
  const loads = perDayLoads(
    await getOverlappingRows(eventId, days, excludeAttendeeId),
    days,
  );
  for (const day of days) {
    if (loads.get(day)! + quantity > event.max_attendees) return false;
  }
  if (event.group_id <= 0) return true;
  const remaining = await getGroupRemainingPerDay(
    event.group_id,
    days,
    excludeAttendeeId,
  );
  if (!remaining) return true;
  for (const day of days) {
    if (quantity > remaining.get(day)!) return false;
  }
  return true;
};

type EventRow = {
  id: number;
  max_attendees: number;
  group_id: number;
  event_type: EventType;
  attendee_count: number;
};

type DemandBucket = { perDay: Map<string, number>; total: number };

/** The days a bucket demands, or null when its demand is total-only. */
const demandedDays = (bucket: DemandBucket): string[] | null =>
  bucket.perDay.size > 0 ? [...bucket.perDay.keys()] : null;

/**
 * Aggregate batch items into per-key demand buckets. The `keyOf(event)`
 * callback selects which bucket each item contributes to (returning null
 * skips the item). Daily events with a date contribute per-day; everything
 * else contributes to a single total per bucket.
 *
 * Used twice: once keyed by event id (for event-cap checks), once keyed by
 * group id (for group-cap checks).
 */
const aggregateDemand = <K>(
  items: BatchAvailabilityItem[],
  eventsById: Map<number, EventRow>,
  date: string | null | undefined,
  keyOf: (ev: EventRow) => K | null,
): Map<K, DemandBucket> => {
  const buckets = new Map<K, DemandBucket>();
  for (const item of items) {
    const ev = eventsById.get(item.eventId)!;
    const key = keyOf(ev);
    if (key === null) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { perDay: new Map(), total: 0 };
      buckets.set(key, bucket);
    }
    const duration = Math.max(1, item.durationDays ?? 1);
    if (ev.event_type === "daily" && date) {
      for (const day of expandDailyRange(date, duration)) {
        bucket.perDay.set(day, (bucket.perDay.get(day) ?? 0) + item.quantity);
      }
    } else {
      bucket.total += item.quantity;
    }
  }
  return buckets;
};

/**
 * Check availability for multiple events in a single preflight pass.
 * For multi-day daily events, expands each booking into per-day demand so
 * that every day in the range is checked independently. Group caps are
 * similarly evaluated per-day across all events in each group.
 */
export const checkBatchAvailabilityImpl = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => {
  if (items.length === 0) return true;
  // Reject negative quantities outright — would otherwise offset positive
  // rows and bypass the cap. Form validation clamps upstream; defensive.
  if (items.some((i) => i.quantity < 0)) return false;
  const eventIds = items.map((i) => i.eventId);

  const eventRows = await queryAll<EventRow>(
    `SELECT e.id, e.max_attendees, e.group_id, e.event_type,
            COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN event_attendees ea ON ea.event_id = e.id
     WHERE e.id IN (${inPlaceholders(eventIds)})
     GROUP BY e.id`,
    eventIds,
  );
  const eventsById = new Map(eventRows.map((r) => [r.id, r]));

  // Every item must reference a known event.
  if (items.some((i) => !eventsById.has(i.eventId))) return false;

  // Event-cap checks: per-day where applicable, total for non-daily/date-less.
  // One overlap fetch per event covers every demanded day at once.
  const eventDemand = aggregateDemand(items, eventsById, date, (ev) => ev.id);
  for (const [eventId, bucket] of eventDemand) {
    const ev = eventsById.get(eventId)!;
    const days = demandedDays(bucket);
    if (days) {
      const loads = perDayLoads(await getOverlappingRows(eventId, days), days);
      for (const [day, qty] of bucket.perDay) {
        if (loads.get(day)! + qty > ev.max_attendees) return false;
      }
    }
    if (bucket.total > 0 && ev.attendee_count + bucket.total > ev.max_attendees)
      return false;
  }

  // Group-cap checks: per-day across the union of requested days in the group.
  const groupDemand = aggregateDemand(items, eventsById, date, (ev) =>
    ev.group_id > 0 ? ev.group_id : null,
  );
  for (const [groupId, bucket] of groupDemand) {
    const days = demandedDays(bucket);
    if (days) {
      const remaining = await getGroupRemainingPerDay(groupId, days);
      if (remaining) {
        for (const [day, qty] of bucket.perDay) {
          if (qty + bucket.total > remaining.get(day)!) return false;
        }
      }
    } else if (bucket.total > 0) {
      // Pure non-daily demand against baseline group occupancy.
      const remaining = (await getGroupRemainingByGroupId([groupId], null)).get(
        groupId,
      );
      if (remaining !== undefined && bucket.total > remaining) return false;
    }
  }
  return true;
};

/**
 * Duration-aware availability check for a single event. For daily events
 * with `durationDays > 1`, every day in the range must have room.
 */
export const hasAvailableSpotsImpl = (
  eventId: number,
  quantity = 1,
  date?: string | null,
  durationDays = 1,
): Promise<boolean> =>
  checkEventAvailability(eventId, quantity, date, undefined, durationDays);
