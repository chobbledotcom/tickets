/**
 * Groups table operations
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { execute, executeBatch } from "#shared/db/client.ts";
import {
  cachedEntityTable,
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { queryListingsWithCounts } from "#shared/db/listings.ts";
import { allNamesById, queryAndMap } from "#shared/db/query.ts";
import { isSlugTakenAnywhere } from "#shared/db/slug-registry.ts";
import { col } from "#shared/db/table.ts";
import type { Group, ListingType, ListingWithCount } from "#shared/types.ts";

/** Groups are few, so the cache loads the whole set and answers by-id / by-slug
 * reads from it — same isolate-level TTL as the listings cache. */
const GROUPS_CACHE_TTL_MS = 30_000;

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

const groupsEntity = cachedEntityTable<Group, GroupInput>(
  "groups",
  rawGroupsTable,
  {
    fetchAll: () => queryGroups("SELECT * FROM groups ORDER BY id ASC"),
    idOf: (g) => g.id,
    keyOf: (g) => g.slug_index,
    ttlMs: GROUPS_CACHE_TTL_MS,
  },
);
const groupsCache = groupsEntity.cache;

/** Groups table with CRUD operations — writes auto-invalidate the cache */
export const groupsTable = groupsEntity.table;

/** Invalidate the groups cache (for testing or after writes). */
export const invalidateGroupsCache = (): void => groupsCache.invalidate();

/**
 * Get all groups, decrypted, ordered by id (from cache)
 */
export const getAllGroups = (): Promise<Group[]> => groupsCache.getAll();

/** Narrow id → name map for every group (selects + decrypts only the name), for
 * pickers/labels that must not load the whole groups cache. */
export const getAllGroupNames = (): Promise<Map<number, string>> =>
  allNamesById("groups", "grp", "name", (raw: string) => decrypt(raw));

/**
 * Get a single group by slug_index (from cache)
 */
export const getGroupBySlugIndex = (slugIndex: string): Promise<Group | null> =>
  groupsCache.getByKey(slugIndex);

/**
 * Check if a group slug is already in use.
 * Checks both listings and groups for cross-table uniqueness.
 */
export const isGroupSlugTaken = (
  slug: string,
  excludeGroupId?: number,
): Promise<boolean> =>
  isSlugTakenAnywhere(
    slug,
    excludeGroupId ? { id: excludeGroupId, table: "groups" } : undefined,
  );

/** Query listings in a group with attendee counts, optionally filtering to active only */
const queryGroupListings = (
  groupId: number,
  activeOnly: boolean,
): Promise<ListingWithCount[]> =>
  queryListingsWithCounts(
    activeOnly
      ? "WHERE listing.active = 1 AND listing.group_id = ?"
      : "WHERE listing.group_id = ?",
    [groupId],
  );

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
export const getUngroupedListings = (): Promise<ListingWithCount[]> =>
  queryListingsWithCounts("WHERE listing.group_id = 0");

/**
 * Assign listings to a group by updating their group_id.
 *
 * All listings move in a single batch transaction, so the reassignment is
 * atomic and costs one round-trip rather than one per listing.
 */
export const assignListingsToGroup = (
  listingIds: number[],
  groupId: number,
): Promise<void> => {
  if (listingIds.length === 0) return Promise.resolve();
  return executeBatch(
    listingIds.map((listingId) => ({
      args: [groupId, listingId],
      sql: "UPDATE listings SET group_id = ? WHERE id = ?",
    })),
  );
};

/**
 * Reset group assignment on all listings in a group.
 */
export const resetGroupListings = async (groupId: number): Promise<void> => {
  await execute("UPDATE listings SET group_id = 0 WHERE group_id = ?", [
    groupId,
  ]);
};

/**
 * Set the `active` flag on every listing in a group.
 * Returns the number of listings affected.
 */
export const setGroupListingsActive = async (
  groupId: number,
  active: boolean,
): Promise<number> => {
  const result = await execute(
    "UPDATE listings SET active = ? WHERE group_id = ?",
    [active ? 1 : 0, groupId],
  );
  return result.rowsAffected;
};
