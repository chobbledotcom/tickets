/**
 * Capacity checks and availability queries for attendees/event_attendees.
 */

import type { InValue } from "@libsql/client";
import { unique } from "#fp";
import type {
  BatchAvailabilityItem,
  EventBooking,
  UpdateEventLinkResult,
} from "#shared/db/attendee-types.ts";
import { buildCapacityCondition, dateToRange } from "#shared/db/capacity.ts";
import { inPlaceholders, queryAll, queryOne } from "#shared/db/client.ts";
import { getEventWithCount, invalidateEventsCache } from "#shared/db/events.ts";

/** Shared failure result for capacity-exceeded */
export const CAPACITY_EXCEEDED = {
  reason: "capacity_exceeded" as const,
  success: false as const,
};

/** Convert nullable date to start_at/end_at (null-safe wrapper around dateToRange) */
export const dateToStartEnd = (
  date: string | null,
): { startAt: string | null; endAt: string | null } => {
  if (!date) return { endAt: null, startAt: null };
  const range = dateToRange(date);
  return { endAt: range.endAt, startAt: range.startAt };
};

/** Get the total attendee quantity for a specific event + date */
export const getDateAttendeeCount = async (
  eventId: number,
  date: string,
): Promise<number> => {
  const { startAt, endAt } = dateToRange(date);
  const rows = await queryAll<{ count: number }>(
    "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ? AND start_at < ? AND end_at > ?",
    [eventId, endAt, startAt],
  );
  return rows[0]!.count;
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
  const { eventId, quantity: qty = 1, pricePaid = 0, date = null } = booking;
  const condition = buildCapacityCondition(eventId, qty, date);
  const { startAt, endAt } = dateToStartEnd(date);
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

type RemainingMap = Map<number, number>;

/**
 * Per-group remaining capacity. Groups with `max_attendees <= 0` (no cap)
 * are omitted from the map. With `date = null`, daily-event attendees count
 * cumulatively — correct for booking-time enforcement after upstream date
 * validation, misleading for display.
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
     LEFT JOIN events e ON e.group_id = g.id
     LEFT JOIN event_attendees ea ON ea.event_id = e.id
       AND ${predicate.sql}
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0
     GROUP BY g.id`,
    [...predicate.args, ...ids],
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
 * Check availability for multiple events in a single query.
 * Uses a JOIN with conditional date filtering: daily events check per-date
 * capacity while standard events check total capacity.
 */
export const checkBatchAvailabilityImpl = async (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => {
  if (items.length === 0) return true;
  const eventIds = items.map((i) => i.eventId);
  const range = date ? dateToRange(date) : null;
  const rows = await queryAll<{
    id: number;
    max_attendees: number;
    current_count: number;
    group_id: number;
  }>(
    `SELECT e.id, e.max_attendees,
            COALESCE(SUM(ea.quantity), 0) as current_count,
            e.group_id
          FROM events e
          LEFT JOIN event_attendees ea ON ea.event_id = e.id
            AND (e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))
          WHERE e.id IN (${inPlaceholders(eventIds)})
          GROUP BY e.id`,
    [range?.endAt ?? null, range?.startAt ?? null, ...eventIds],
  );
  const counts = new Map(rows.map((r) => [r.id, r]));
  // Per-event capacity check
  const eventOk = items.every((item) => {
    const row = counts.get(item.eventId);
    return row ? row.current_count + item.quantity <= row.max_attendees : false;
  });
  if (!eventOk) return false;

  const groupIds = unique(
    rows.filter((r) => r.group_id > 0).map((r) => r.group_id),
  );
  const remainingByGroupId = await getGroupRemainingByGroupId(
    groupIds,
    date ?? null,
  );
  for (const [groupId, remaining] of remainingByGroupId) {
    const requestedInGroup = items.reduce((sum, item) => {
      const row = counts.get(item.eventId);
      return row && row.group_id === groupId ? sum + item.quantity : sum;
    }, 0);
    if (requestedInGroup > remaining) return false;
  }
  return true;
};

/** Check if an event has available spots for the requested quantity */
export const hasAvailableSpotsImpl = async (
  eventId: number,
  quantity = 1,
  date?: string | null,
): Promise<boolean> => {
  const event = await getEventWithCount(eventId);
  if (!event) return false;
  if (date) {
    const dateCount = await getDateAttendeeCount(eventId, date);
    if (dateCount + quantity > event.max_attendees) return false;
  } else {
    if (event.attendee_count + quantity > event.max_attendees) return false;
  }
  // Check group capacity if event belongs to a group with a limit
  if (event.group_id > 0) {
    const remainingByGroupId = await getGroupRemainingByGroupId(
      [event.group_id],
      date ?? null,
    );
    const remaining = remainingByGroupId.get(event.group_id);
    if (remaining !== undefined && quantity > remaining) return false;
  }
  return true;
};
