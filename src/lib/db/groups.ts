/**
 * Groups table operations
 */

import { mapAsync } from "#fp";
import { decrypt, encrypt, hmacHash } from "#lib/crypto.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import { encryptedNameSchema, idAndEncryptedSlugSchema } from "#lib/db/common-schema.ts";
import { defineIdTable } from "#lib/db/define-id-table.ts";
import { queryAndMap } from "#lib/db/query.ts";
import { eventsTable } from "#lib/db/events.ts";
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

/** Groups table with CRUD operations */
export const groupsTable = defineIdTable<Group, GroupInput>("groups", {
  ...encryptedNameSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  terms_and_conditions: { default: () => "", write: encrypt, read: decrypt },
});

/** Execute a query and decrypt the resulting group rows */
const queryGroups = queryAndMap<Group, Group>((row) => groupsTable.fromDb(row));

/**
 * Get all groups, decrypted, ordered by id
 */
export const getAllGroups = (): Promise<Group[]> =>
  queryGroups("SELECT * FROM groups ORDER BY id ASC");

/**
 * Get a single group by slug_index
 */
export const getGroupBySlugIndex = async (
  slugIndex: string,
): Promise<Group | null> => {
  const result = await queryGroups({
    sql: "SELECT * FROM groups WHERE slug_index = ? LIMIT 1",
    args: [slugIndex],
  });
  return result[0] ?? null;
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
};

/**
 * Reset group assignment on all events in a group.
 */
export const resetGroupEvents = async (groupId: number): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE events SET group_id = 0 WHERE group_id = ?",
    args: [groupId],
  });
};
