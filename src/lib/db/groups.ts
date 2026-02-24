/**
 * Groups table operations
 */

import { collectionCache, mapAsync } from "#fp";
import { registerCache } from "#lib/cache-registry.ts";
import { decrypt, encrypt, hmacHash } from "#lib/crypto.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import { encryptedNameSchema, idAndEncryptedSlugSchema } from "#lib/db/common-schema.ts";
import { defineIdTable } from "#lib/db/define-id-table.ts";
import { queryAndMap } from "#lib/db/query.ts";
import { eventsTable, invalidateEventsCache } from "#lib/db/events.ts";
import type { Event, EventWithCount, Group } from "#lib/types.ts";

/** Group input fields for create/update (camelCase) */
export type GroupInput = {
  slug: string;
  slugIndex: string;
  name: string;
  termsAndConditions: string;
};

/** Compute slug index from slug for blind index lookup */
export const computeGroupSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

/**
 * In-memory groups cache. Loads all groups in a single query and
 * serves subsequent reads from memory until the TTL expires or a
 * write invalidates the cache.
 */
export const GROUPS_CACHE_TTL_MS = 60_000;

/** Raw groups table with CRUD operations */
const rawGroupsTable = defineIdTable<Group, GroupInput>("groups", {
  ...encryptedNameSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  terms_and_conditions: { default: () => "", write: encrypt, read: decrypt },
});

/** Execute a query and decrypt the resulting group rows */
const queryGroups = queryAndMap<Group, Group>((row) => rawGroupsTable.fromDb(row));

const groupsCache = collectionCache(
  () => queryGroups("SELECT * FROM groups ORDER BY id ASC"),
  GROUPS_CACHE_TTL_MS,
);

registerCache(() => ({ name: "groups", entries: groupsCache.size() }));

/** Invalidate the groups cache (for testing or after writes). */
export const invalidateGroupsCache = (): void => {
  groupsCache.invalidate();
};

/** Groups table with CRUD operations — writes auto-invalidate the cache */
export const groupsTable: typeof rawGroupsTable = {
  ...rawGroupsTable,
  insert: async (input) => {
    const result = await rawGroupsTable.insert(input);
    invalidateGroupsCache();
    return result;
  },
  update: async (id, input) => {
    const result = await rawGroupsTable.update(id, input);
    invalidateGroupsCache();
    return result;
  },
  deleteById: async (id) => {
    await rawGroupsTable.deleteById(id);
    invalidateGroupsCache();
  },
};

/**
 * Get all groups, decrypted, ordered by id (from cache)
 */
export const getAllGroups = (): Promise<Group[]> =>
  groupsCache.getAll();

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
    sql: "SELECT 1 FROM events WHERE slug_index = ? LIMIT 1",
    args: [slugIndex],
  });
  if (eventHit.rows.length > 0) return true;

  const sql = excludeGroupId
    ? "SELECT 1 FROM groups WHERE slug_index = ? AND id != ? LIMIT 1"
    : "SELECT 1 FROM groups WHERE slug_index = ? LIMIT 1";
  const args = excludeGroupId ? [slugIndex, excludeGroupId] : [slugIndex];
  const groupHit = await getDb().execute({ sql, args });
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
  const where = activeOnly ? "e.active = 1 AND e.group_id = ?" : "e.group_id = ?";
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE ${where}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
    [groupId],
  );

  return mapAsync(decryptEventWithCount)(rows);
};

/**
 * Get active events in a group with attendee counts.
 */
export const getActiveEventsByGroupId = (groupId: number): Promise<EventWithCount[]> =>
  queryGroupEvents(groupId, true);

/**
 * Get all events in a group with attendee counts (including inactive).
 */
export const getEventsByGroupId = (groupId: number): Promise<EventWithCount[]> =>
  queryGroupEvents(groupId, false);

/**
 * Get ungrouped events (group_id = 0) with attendee counts.
 */
export const getUngroupedEvents = async (): Promise<EventWithCount[]> => {
  const rows = await queryAll<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.group_id = 0
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );

  return mapAsync(decryptEventWithCount)(rows);
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
      sql: "UPDATE events SET group_id = ? WHERE id = ?",
      args: [groupId, eventId],
    });
  }
  if (eventIds.length > 0) invalidateEventsCache();
};

/**
 * Reset group assignment on all events in a group.
 */
export const resetGroupEvents = async (groupId: number): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE events SET group_id = 0 WHERE group_id = ?",
    args: [groupId],
  });
  invalidateEventsCache();
};
