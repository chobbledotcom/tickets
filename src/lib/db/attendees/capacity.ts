/**
 * Capacity checks and availability queries for attendees/event_attendees.
 */

import type { InValue } from "@libsql/client";
import { unique } from "#fp";
import type {
  BatchAvailabilityItem,
  EventBooking,
  UpdateEventLinkResult,
} from "#lib/db/attendee-types.ts";
import { buildCapacityCondition, dateToRange } from "#lib/db/capacity.ts";
import { inPlaceholders, queryAll, queryOne } from "#lib/db/client.ts";
import { getEventWithCount, invalidateEventsCache } from "#lib/db/events.ts";
import type { EventType } from "#lib/types.ts";

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

/** Get a group's max_attendees limit (0 = no limit) */
export const getGroupMaxAttendees = async (
  groupId: number,
): Promise<number> => {
  const row = await queryOne<{ max_attendees: number }>(
    "SELECT max_attendees FROM groups WHERE id = ?",
    [groupId],
  );
  return row?.max_attendees ?? 0;
};

/**
 * Count total attendees across all events in a group.
 * Date-aware: standard events always count, daily events only count matching date.
 */
export const getGroupAttendeeCount = async (
  groupId: number,
  date: string | null,
): Promise<number> => {
  const range = date ? dateToRange(date) : null;
  const rows = await queryAll<{ count: number }>(
    `SELECT COALESCE(SUM(ea.quantity), 0) as count
     FROM event_attendees ea
     JOIN events e ON e.id = ea.event_id
     WHERE e.group_id = ?
       AND (? IS NULL OR e.event_type != 'daily' OR (ea.start_at < ? AND ea.end_at > ?))`,
    [groupId, date, range?.endAt ?? null, range?.startAt ?? null],
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

/**
 * Compute remaining group capacity for each given group id (only for groups
 * with a non-zero max_attendees limit). Used by the public UI/API to surface
 * group-aware sold-out state when an event is bought outside the group URL.
 *
 * Note: this is a non-date-aware count, so it should only be used for groups
 * containing standard events. Daily-event groups use per-date enforcement at
 * booking time via buildCapacityCondition; surfacing a cumulative count here
 * would falsely mark dates with room as sold out.
 */
export const getGroupRemainingByGroupId = async (
  groupIds: number[],
): Promise<Map<number, number>> => {
  const ids = unique(groupIds.filter((id) => id > 0));
  if (ids.length === 0) return new Map();
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
     WHERE g.id IN (${inPlaceholders(ids)}) AND g.max_attendees > 0
     GROUP BY g.id`,
    ids,
  );
  return new Map(
    rows.map((r) => [r.group_id, Math.max(0, r.max_attendees - r.count)]),
  );
};

/** Event shape required to look up group remaining for display. */
type EventForGroupLookup = {
  id: number;
  group_id: number;
  event_type: EventType;
};

/**
 * Look up group remaining capacity for a list of events. Returns a map keyed
 * by event id; only includes standard events whose group has a positive
 * max_attendees. Daily events are skipped because their group cap is enforced
 * per date at booking time, and a cumulative count here would mislead the
 * sold-out display for dates that still have room.
 */
export const getGroupRemainingByEventId = async (
  events: EventForGroupLookup[],
): Promise<Map<number, number>> => {
  const standard = events.filter((e) => e.event_type !== "daily");
  const groupIds = standard.map((e) => e.group_id);
  const groupMap = await getGroupRemainingByGroupId(groupIds);
  const result = new Map<number, number>();
  for (const event of standard) {
    const remaining = groupMap.get(event.group_id);
    if (remaining !== undefined) result.set(event.id, remaining);
  }
  return result;
};

/** Convenience wrapper for a single event. Returns undefined when no group
 * cap applies (no group, no limit, or daily event). */
export const getGroupRemainingForEvent = async (
  event: EventForGroupLookup,
): Promise<number | undefined> => {
  const map = await getGroupRemainingByEventId([event]);
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

  // Group capacity check: collect unique group IDs with limits
  const groupIds = new Set<number>();
  for (const row of rows) {
    if (row.group_id > 0) groupIds.add(row.group_id);
  }
  for (const groupId of groupIds) {
    const groupLimit = await getGroupMaxAttendees(groupId);
    if (groupLimit <= 0) continue;
    const groupCount = await getGroupAttendeeCount(groupId, date ?? null);
    // Sum requested quantities for events in this group
    const requestedInGroup = items.reduce((sum, item) => {
      const row = counts.get(item.eventId);
      return row && row.group_id === groupId ? sum + item.quantity : sum;
    }, 0);
    if (groupCount + requestedInGroup > groupLimit) return false;
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
    const groupLimit = await getGroupMaxAttendees(event.group_id);
    if (groupLimit > 0) {
      const groupCount = await getGroupAttendeeCount(
        event.group_id,
        date ?? null,
      );
      if (groupCount + quantity > groupLimit) return false;
    }
  }
  return true;
};
