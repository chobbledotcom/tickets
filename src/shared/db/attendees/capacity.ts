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

/**
 * Get the total attendee quantity for a specific event + date, optionally
 * excluding one attendee (used when an admin edits their own booking so the
 * row being updated doesn't fight itself in the capacity check).
 */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
  excludeAttendeeId?: number,
): Promise<number> => {
  const { startAt, endAt } = dateToRange(date);
  const sql = excludeAttendeeId
    ? "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND attendee_id != ? AND start_at < ? AND end_at > ?"
    : "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND start_at < ? AND end_at > ?";
  const args: InValue[] = excludeAttendeeId
    ? [eventId, excludeAttendeeId, endAt, startAt]
    : [eventId, endAt, startAt];
  const rows = await queryAll<{ count: number }>(sql, args);
  return rows[0]!.count;
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
// ---------------------------------------------------------------------------

/** Enumerate every day in [date, date + durationDays) for per-day checks,
 * or a single [null] for non-daily / date-less bookings. */
const capacityCheckDays = (
  isDaily: boolean,
  date: string | null | undefined,
  durationDays: number,
): (string | null)[] => {
  if (!isDaily || !date) return [null];
  const duration = Math.max(1, Math.floor(durationDays));
  return Array.from({ length: duration }, (_, i) => addDays(date, i));
};

const loadForDay = async (
  eventId: number,
  day: string | null,
  excludeAttendeeId: number | undefined,
  attendeeCount: number,
): Promise<number> => {
  if (day) return getDateAttendeeCount(eventId, day, excludeAttendeeId);
  if (!excludeAttendeeId) return attendeeCount;
  return (await queryOne<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND attendee_id != ?",
    [eventId, excludeAttendeeId],
  ))!.count;
};

const checkEventCapForDays = async (
  eventId: number,
  quantity: number,
  days: (string | null)[],
  excludeAttendeeId: number | undefined,
  event: { max_attendees: number; attendee_count: number },
): Promise<boolean> => {
  for (const day of days) {
    const load = await loadForDay(
      eventId,
      day,
      excludeAttendeeId,
      event.attendee_count,
    );
    if (load + quantity > event.max_attendees) return false;
  }
  return true;
};

const checkGroupCapForDays = async (
  groupId: number,
  quantity: number,
  days: (string | null)[],
  excludeAttendeeId: number | undefined,
): Promise<boolean> => {
  for (const day of days) {
    const remaining = (
      await getGroupRemainingByGroupId([groupId], day, excludeAttendeeId)
    ).get(groupId);
    if (remaining !== undefined && quantity > remaining) return false;
  }
  return true;
};

/**
 * Accurate per-day availability check for a single-event booking, shared by
 * `hasAvailableSpots`, `addEventLink`, and `updateEventLink`.
 *
 * Walks every day in `[date, date + durationDays)` and checks event cap +
 * group cap per-day. The atomic SQL still runs its own WHERE-guarded check
 * as a race-free safety net; this preflight ensures we don't false-reject
 * multi-day ranges with non-overlapping existing bookings.
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
  const days = capacityCheckDays(
    event.event_type === "daily",
    date,
    durationDays,
  );
  const eventOk = await checkEventCapForDays(
    eventId,
    quantity,
    days,
    excludeAttendeeId,
    event,
  );
  if (!eventOk) return false;
  if (event.group_id <= 0) return true;
  return checkGroupCapForDays(
    event.group_id,
    quantity,
    days,
    excludeAttendeeId,
  );
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

  const eventRows = await queryAll<{
    id: number;
    max_attendees: number;
    group_id: number;
    event_type: EventType;
    attendee_count: number;
  }>(
    `SELECT e.id, e.max_attendees, e.group_id, e.event_type,
            COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN event_attendees ea ON ea.event_id = e.id
     WHERE e.id IN (${inPlaceholders(eventIds)})
     GROUP BY e.id`,
    eventIds,
  );
  const eventsById = new Map(eventRows.map((r) => [r.id, r]));

  const daysOfRange = (startDate: string, durationDays: number): string[] => {
    const duration = Math.max(1, Math.floor(durationDays));
    return Array.from({ length: duration }, (_, i) => addDays(startDate, i));
  };

  // Per-day demand by (eventId, day) → quantity. Non-daily / date-less
  // demand is aggregated per event.
  const perDayDemand = new Map<number, Map<string, number>>();
  const totalDemand = new Map<number, number>();

  for (const item of items) {
    const ev = eventsById.get(item.eventId);
    if (!ev) return false;
    const duration = Math.max(1, item.durationDays ?? 1);
    if (ev.event_type === "daily" && date) {
      const dayMap =
        perDayDemand.get(item.eventId) ?? new Map<string, number>();
      for (const day of daysOfRange(date, duration)) {
        dayMap.set(day, (dayMap.get(day) ?? 0) + item.quantity);
      }
      perDayDemand.set(item.eventId, dayMap);
    } else {
      totalDemand.set(
        item.eventId,
        (totalDemand.get(item.eventId) ?? 0) + item.quantity,
      );
    }
  }

  // Per-day event-cap checks.
  for (const [eventId, dayMap] of perDayDemand) {
    const ev = eventsById.get(eventId)!;
    for (const [day, qty] of dayMap) {
      const existing = await getDateAttendeeCount(eventId, day);
      if (existing + qty > ev.max_attendees) return false;
    }
  }

  // Total-cap checks for non-daily demand.
  for (const [eventId, qty] of totalDemand) {
    const ev = eventsById.get(eventId)!;
    if (ev.attendee_count + qty > ev.max_attendees) return false;
  }

  // Group caps: per-day across the union of requested days in the group.
  const groupIds = unique(
    eventRows.filter((r) => r.group_id > 0).map((r) => r.group_id),
  );
  for (const groupId of groupIds) {
    const groupDayDemand = new Map<string, number>();
    let groupNonDailyDemand = 0;
    for (const item of items) {
      const ev = eventsById.get(item.eventId);
      if (!ev || ev.group_id !== groupId) continue;
      const duration = Math.max(1, item.durationDays ?? 1);
      if (ev.event_type === "daily" && date) {
        for (const day of daysOfRange(date, duration)) {
          groupDayDemand.set(
            day,
            (groupDayDemand.get(day) ?? 0) + item.quantity,
          );
        }
      } else {
        groupNonDailyDemand += item.quantity;
      }
    }

    // For each requested day, check group remaining including non-daily demand.
    for (const [day, qty] of groupDayDemand) {
      const remaining = (await getGroupRemainingByGroupId([groupId], day)).get(
        groupId,
      );
      if (remaining !== undefined && qty + groupNonDailyDemand > remaining)
        return false;
    }
    // Pure non-daily demand against baseline group occupancy.
    if (groupDayDemand.size === 0 && groupNonDailyDemand > 0) {
      const remaining = (await getGroupRemainingByGroupId([groupId], null)).get(
        groupId,
      );
      if (remaining !== undefined && groupNonDailyDemand > remaining)
        return false;
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
