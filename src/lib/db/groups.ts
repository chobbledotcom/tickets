/**
 * Groups table operations
 */

import { mapParallel } from "#fp";
import { decrypt, encrypt } from "#lib/crypto/encryption.ts";
import { hmacHash } from "#lib/crypto/hashing.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
  registerCache,
} from "#lib/db/common-schema.ts";
import { eventsTable, invalidateEventsCache } from "#lib/db/events.ts";
import { queryAndMap } from "#lib/db/query.ts";
import { col, withCacheInvalidation } from "#lib/db/table.ts";
import { requestCache } from "#lib/request-cache.ts";
import type { Event, EventType, EventWithCount, Group } from "#lib/types.ts";

/** Group input fields for create/update (camelCase) */
export type GroupInput = {
  slug: string;
  slugIndex: string;
  name: string;
  description?: string;
  termsAndConditions?: string;
  maxAttendees?: number;
  hidden?: boolean;
};

/** Compute slug index from slug for blind index lookup */
export const computeGroupSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

/** Raw groups table with CRUD operations */
const rawGroupsTable = defineIdTable<Group, GroupInput>("groups", {
  ...encryptedNameSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  description: col.encryptedText(encrypt, decrypt),
  hidden: col.boolean(false),
  max_attendees: col.simple<number>(),
  terms_and_conditions: col.encryptedText(encrypt, decrypt),
});

/** Execute a query and decrypt the resulting group rows */
const queryGroups = queryAndMap<Group, Group>((row) =>
  rawGroupsTable.fromDb(row),
);

const groupsCache = requestCache(() =>
  queryGroups("SELECT * FROM groups ORDER BY id ASC"),
);

registerCache(() => ({ entries: groupsCache.size(), name: "groups" }));

/** Invalidate the groups cache (for testing or after writes). */
export const invalidateGroupsCache = (): void => {
  groupsCache.invalidate();
};

/** Groups table with CRUD operations — writes auto-invalidate the cache */
export const groupsTable = withCacheInvalidation(
  rawGroupsTable,
  invalidateGroupsCache,
);

/**
 * Get all groups, decrypted, ordered by id (from cache)
 */
export const getAllGroups = (): Promise<Group[]> => groupsCache.getAll();

/**
 * Get a single group by slug_index (from cache)
 */
export const getGroupBySlugIndex = async (
  slugIndex: string,
): Promise<Group | null> => {
  const groups = await groupsCache.getAll();
  return groups.find((g) => g.slug_index === slugIndex) ?? null;
};

/**
 * Check if a group slug is already in use.
 * Checks both events and groups for cross-table uniqueness.
 */
export const isGroupSlugTaken = async (
  slug: string,
  excludeGroupId?: number,
): Promise<boolean> => {
  const slugIndex = await computeGroupSlugIndex(slug);

  const eventHit = await getDb().execute({
    args: [slugIndex],
    sql: "SELECT 1 FROM events WHERE slug_index = ? LIMIT 1",
  });
  if (eventHit.rows.length > 0) return true;

  const sql = excludeGroupId
    ? "SELECT 1 FROM groups WHERE slug_index = ? AND id != ? LIMIT 1"
    : "SELECT 1 FROM groups WHERE slug_index = ? LIMIT 1";
  const args = excludeGroupId ? [slugIndex, excludeGroupId] : [slugIndex];
  const groupHit = await getDb().execute({ args, sql });
  return groupHit.rows.length > 0;
};

/** Decrypt event fields while preserving attendee_count */
const decryptEventWithCount = async (
  row: EventWithCount,
): Promise<EventWithCount> => {
  const evt = await eventsTable.fromDb(row as Event);
  return {
    ...evt,
    attendee_count: row.attendee_count,
  };
};

/** Query events in a group with attendee counts, optionally filtering to active only */
const queryGroupEvents = async (
  groupId: number,
  activeOnly: boolean,
): Promise<EventWithCount[]> => {
  const where = activeOnly
    ? "e.active = 1 AND e.group_id = ?"
    : "e.group_id = ?";
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN event_attendees ea ON e.id = ea.event_id
     WHERE ${where}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
    [groupId],
  );

  return mapParallel(decryptEventWithCount)(rows);
};

/**
 * Get active events in a group with attendee counts.
 */
export const getActiveEventsByGroupId = (
  groupId: number,
): Promise<EventWithCount[]> => queryGroupEvents(groupId, true);

/**
 * Get all events in a group with attendee counts (including inactive).
 */
export const getEventsByGroupId = (
  groupId: number,
): Promise<EventWithCount[]> => queryGroupEvents(groupId, false);

/**
 * Validate that an event type is compatible with a group's existing events.
 * Returns an error message if mismatched, null if OK.
 * Pass excludeEventId to skip a specific event (for edit-self case).
 */
export const validateGroupEventType = async (
  groupId: number,
  eventType: EventType,
  excludeEventId?: number,
): Promise<string | null> => {
  const siblings = await getEventsByGroupId(groupId);
  const other = siblings.find(
    (e) => e.id !== excludeEventId && e.event_type !== eventType,
  );
  return other
    ? `This group already contains ${other.event_type} events — all events in a group must be the same type`
    : null;
};

/**
 * Get ungrouped events (group_id = 0) with attendee counts.
 */
export const getUngroupedEvents = async (): Promise<EventWithCount[]> => {
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN event_attendees ea ON e.id = ea.event_id
     WHERE e.group_id = 0
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );

  return mapParallel(decryptEventWithCount)(rows);
};

/**
 * Assign events to a group by updating their group_id.
 */
export const assignEventsToGroup = async (
  eventIds: number[],
  groupId: number,
): Promise<void> => {
  for (const eventId of eventIds) {
    await getDb().execute({
      args: [groupId, eventId],
      sql: "UPDATE events SET group_id = ? WHERE id = ?",
    });
  }
  if (eventIds.length > 0) invalidateEventsCache();
};

/**
 * Reset group assignment on all events in a group.
 */
export const resetGroupEvents = async (groupId: number): Promise<void> => {
  await getDb().execute({
    args: [groupId],
    sql: "UPDATE events SET group_id = 0 WHERE group_id = ?",
  });
  invalidateEventsCache();
};
