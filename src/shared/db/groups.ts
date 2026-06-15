/**
 * Groups table operations
 */

import { mapParallel } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { invalidateListingsCache, listingsTable } from "#shared/db/listings.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { cachedTable, col } from "#shared/db/table.ts";
import type {
  Group,
  Listing,
  ListingType,
  ListingWithCount,
} from "#shared/types.ts";

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

const groupsCache = cachedTable({
  fetchAll: () => queryGroups("SELECT * FROM groups ORDER BY id ASC"),
  name: "groups",
  table: rawGroupsTable,
});

/** Groups table with CRUD operations — writes auto-invalidate the cache */
export const groupsTable = groupsCache.table;

/** Invalidate the groups cache (for testing or after writes). */
export const invalidateGroupsCache = (): void => {
  groupsCache.invalidate();
};

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
 * Checks both listings and groups for cross-table uniqueness.
 */
export const isGroupSlugTaken = async (
  slug: string,
  excludeGroupId?: number,
): Promise<boolean> => {
  const slugIndex = await computeGroupSlugIndex(slug);

  const listingHit = await getDb().execute({
    args: [slugIndex],
    sql: "SELECT 1 FROM listings WHERE slug_index = ? LIMIT 1",
  });
  if (listingHit.rows.length > 0) return true;

  const sql = excludeGroupId
    ? "SELECT 1 FROM groups WHERE slug_index = ? AND id != ? LIMIT 1"
    : "SELECT 1 FROM groups WHERE slug_index = ? LIMIT 1";
  const args = excludeGroupId ? [slugIndex, excludeGroupId] : [slugIndex];
  const groupHit = await getDb().execute({ args, sql });
  return groupHit.rows.length > 0;
};

/** Decrypt listing fields while preserving attendee_count */
const decryptListingWithCount = async (
  row: ListingWithCount,
): Promise<ListingWithCount> => {
  const evt = await listingsTable.fromDb(row as Listing);
  return {
    ...evt,
    attendee_count: row.attendee_count,
  };
};

/** Query listings in a group with attendee counts, optionally filtering to active only */
const queryGroupListings = async (
  groupId: number,
  activeOnly: boolean,
): Promise<ListingWithCount[]> => {
  const where = activeOnly
    ? "e.active = 1 AND e.group_id = ?"
    : "e.group_id = ?";
  const rows = await queryAll<ListingWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM listings e
     LEFT JOIN listing_attendees ea ON e.id = ea.listing_id
     WHERE ${where}
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
    [groupId],
  );

  return mapParallel(decryptListingWithCount)(rows);
};

/**
 * Get active listings in a group with attendee counts.
 */
export const getActiveListingsByGroupId = (
  groupId: number,
): Promise<ListingWithCount[]> => queryGroupListings(groupId, true);

/**
 * Get all listings in a group with attendee counts (including inactive).
 */
export const getListingsByGroupId = (
  groupId: number,
): Promise<ListingWithCount[]> => queryGroupListings(groupId, false);

/**
 * Validate that a listing is compatible with a group's existing listings.
 * Every listing in a group must share both the same {@link ListingType} and
 * the same `customisable_days` setting, so the shared booking form can show a
 * single day-count selector (or none) for the whole group.
 * Returns an error message if mismatched, null if OK.
 * Pass excludeListingId to skip a specific listing (for edit-self case).
 */
export const validateGroupListingType = async (
  groupId: number,
  listingType: ListingType,
  customisableDays: boolean,
  excludeListingId?: number,
): Promise<string | null> => {
  const allSiblings = await getListingsByGroupId(groupId);
  const siblings = allSiblings.filter((e) => e.id !== excludeListingId);
  const typeMismatch = siblings.find((e) => e.listing_type !== listingType);
  if (typeMismatch) {
    return `This group already contains ${typeMismatch.listing_type} listings — all listings in a group must be the same type`;
  }
  const customisableMismatch = siblings.find(
    (e) => e.customisable_days !== customisableDays,
  );
  if (customisableMismatch) {
    return customisableMismatch.customisable_days
      ? "This group already contains listings with customisable days — all listings in a group must match"
      : "This group already contains listings without customisable days — all listings in a group must match";
  }
  return null;
};

/**
 * Get ungrouped listings (group_id = 0) with attendee counts.
 */
export const getUngroupedListings = async (): Promise<ListingWithCount[]> => {
  const rows = await queryAll<ListingWithCount>(
    `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
     FROM listings e
     LEFT JOIN listing_attendees ea ON e.id = ea.listing_id
     WHERE e.group_id = 0
     GROUP BY e.id
     ORDER BY e.created DESC, e.id DESC`,
  );

  return mapParallel(decryptListingWithCount)(rows);
};

/**
 * Assign listings to a group by updating their group_id.
 */
export const assignListingsToGroup = async (
  listingIds: number[],
  groupId: number,
): Promise<void> => {
  for (const listingId of listingIds) {
    await getDb().execute({
      args: [groupId, listingId],
      sql: "UPDATE listings SET group_id = ? WHERE id = ?",
    });
  }
  if (listingIds.length > 0) invalidateListingsCache();
};

/**
 * Reset group assignment on all listings in a group.
 */
export const resetGroupListings = async (groupId: number): Promise<void> => {
  await getDb().execute({
    args: [groupId],
    sql: "UPDATE listings SET group_id = 0 WHERE group_id = ?",
  });
  invalidateListingsCache();
};

/**
 * Set the `active` flag on every listing in a group.
 * Returns the number of listings affected.
 */
export const setGroupListingsActive = async (
  groupId: number,
  active: boolean,
): Promise<number> => {
  const result = await getDb().execute({
    args: [active ? 1 : 0, groupId],
    sql: "UPDATE listings SET active = ? WHERE group_id = ?",
  });
  invalidateListingsCache();
  return result.rowsAffected;
};
