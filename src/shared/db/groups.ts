/**
 * Groups table operations
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
} from "#shared/db/client.ts";
import {
  cachedEntityTable,
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { queryListingsWithCounts } from "#shared/db/listings.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { col } from "#shared/db/table.ts";
import type {
  Group,
  GroupListing,
  ListingType,
  ListingWithCount,
} from "#shared/types.ts";

/** Groups are few, so the cache loads the whole set and answers by-id / by-slug
 * reads from it — same isolate-level TTL as the listings cache. */
const GROUPS_CACHE_TTL_MS = 30_000;

/** A package member's per-unit price override and fixed quantity, as parsed from
 * the group edit form / API. `price` is minor units (0 = no override, use the
 * listing's own price); `quantity` is how many of this listing one package unit
 * includes (≥1). */
export type PackageMemberInput = {
  listingId: number;
  price: number;
  /** How many of this listing one package unit includes (≥1). Defaults to 1. */
  quantity?: number;
};

/** Group input fields for create/update (camelCase) */
export type GroupInput = {
  slug: string;
  slugIndex: string;
  name: string;
  description?: string;
  termsAndConditions?: string;
  maxAttendees?: number;
  hidden?: boolean;
  isPackage?: boolean;
  hidePackageListings?: boolean;
  /** Per-listing package overrides (price + quantity). Absent means "leave
   * existing rows untouched" (partial API update); an empty array clears every
   * override back to price 0 / quantity 1. */
  packageMembers?: PackageMemberInput[];
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
  hide_package_listings: col.boolean(false),
  is_package: col.boolean(false),
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

/**
 * Get a single group by slug_index (from cache)
 */
export const getGroupBySlugIndex = (slugIndex: string): Promise<Group | null> =>
  groupsCache.getByKey(slugIndex);

/**
 * Check if a group slug is already in use.
 * Checks both listings and groups for cross-table uniqueness.
 */
export const isGroupSlugTaken = async (
  slug: string,
  excludeGroupId?: number,
): Promise<boolean> => {
  const slugIndex = await computeGroupSlugIndex(slug);

  const listingHit = await queryAll(
    "SELECT 1 FROM listings WHERE slug_index = ? LIMIT 1",
    [slugIndex],
  );
  if (listingHit.length > 0) return true;

  const sql = excludeGroupId
    ? "SELECT 1 FROM groups WHERE slug_index = ? AND id != ? LIMIT 1"
    : "SELECT 1 FROM groups WHERE slug_index = ? LIMIT 1";
  const args = excludeGroupId ? [slugIndex, excludeGroupId] : [slugIndex];
  const groupHit = await queryAll(sql, args);
  return groupHit.length > 0;
};

/** WHERE fragment matching listings that are members of the given group, via the
 * group_listings join table (subquery form avoids duplicate rows). */
const IN_GROUP_SQL =
  "listing.id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)";

/** Query listings in a group with attendee counts, optionally filtering to active only */
const queryGroupListings = (
  groupId: number,
  activeOnly: boolean,
): Promise<ListingWithCount[]> =>
  queryListingsWithCounts(
    activeOnly
      ? `WHERE listing.active = 1 AND ${IN_GROUP_SQL}`
      : `WHERE ${IN_GROUP_SQL}`,
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
 * Get ungrouped listings (members of no group) with attendee counts.
 */
export const getUngroupedListings = (): Promise<ListingWithCount[]> =>
  queryListingsWithCounts(
    "WHERE listing.id NOT IN (SELECT listing_id FROM group_listings)",
  );

/** The ids of every group a listing belongs to, ascending. */
export const getGroupIdsByListingId = async (
  listingId: number,
): Promise<number[]> => {
  const rows = await queryAll<{ group_id: number }>(
    "SELECT group_id FROM group_listings WHERE listing_id = ? ORDER BY group_id ASC",
    [listingId],
  );
  return rows.map((r) => r.group_id);
};

/** Whether any of the given group ids names a package group. Empty input → false
 * (no query). The shared check the listing API and the children sub-form use to
 * keep a listing that requires children out of a package group. */
export const anyPackageGroup = async (
  groupIds: readonly number[],
): Promise<boolean> => {
  if (groupIds.length === 0) return false;
  const rows = await queryAll<{ id: number }>(
    `SELECT id FROM groups WHERE id IN (${inPlaceholders(
      groupIds,
    )}) AND is_package = 1 LIMIT 1`,
    [...groupIds],
  );
  return rows.length > 0;
};

/** The listing ids that are members of a group, ascending. */
export const getGroupListingIds = async (
  groupId: number,
): Promise<number[]> => {
  const rows = await queryAll<{ listing_id: number }>(
    "SELECT listing_id FROM group_listings WHERE group_id = ? ORDER BY listing_id ASC",
    [groupId],
  );
  return rows.map((r) => r.listing_id);
};

/** Map each listing id to the ids of the groups it belongs to, in one query.
 * Listings that belong to no group are absent from the map. */
export const getGroupIdsByListingIds = async (
  listingIds: number[],
): Promise<Map<number, number[]>> => {
  const result = new Map<number, number[]>();
  if (listingIds.length === 0) return result;
  const rows = await queryAll<{ group_id: number; listing_id: number }>(
    `SELECT group_id, listing_id FROM group_listings
       WHERE listing_id IN (${inPlaceholders(listingIds)})
     ORDER BY group_id ASC`,
    listingIds,
  );
  for (const row of rows) {
    const list = result.get(row.listing_id);
    if (list) list.push(row.group_id);
    else result.set(row.listing_id, [row.group_id]);
  }
  return result;
};

/**
 * Add listings to a group (membership rows), ignoring any already present.
 *
 * All rows insert in a single batch transaction, so the change is atomic and
 * costs one round-trip rather than one per listing.
 */
export const assignListingsToGroup = (
  listingIds: number[],
  groupId: number,
): Promise<void> => {
  if (listingIds.length === 0) return Promise.resolve();
  // INSERT ... SELECT gated on the listing existing, so an unknown id is a no-op
  // (the join table has no FK, so a stale/crafted id would otherwise leave an
  // orphan membership row that the old `UPDATE listings WHERE id` never created).
  return executeBatch(
    listingIds.map((listingId) => ({
      args: [groupId, listingId, listingId],
      sql: "INSERT OR IGNORE INTO group_listings (group_id, listing_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM listings WHERE id = ?)",
    })),
  );
};

/**
 * Replace a listing's full set of group memberships (the listing-form
 * checkboxes). Rows for groups that remain are left untouched so their
 * `package_price` overrides survive; only newly-ticked groups are inserted and
 * unticked ones removed.
 */
export const setListingGroups = async (
  listingId: number,
  groupIds: number[],
): Promise<void> => {
  const current = new Set(await getGroupIdsByListingId(listingId));
  const desired = new Set(groupIds);
  // Statements for the group ids in `ids` that are absent from `exclude`.
  const rowsFor = (ids: Set<number>, exclude: Set<number>, sql: string) =>
    [...ids]
      .filter((id) => !exclude.has(id))
      .map((groupId) => ({ args: [groupId, listingId], sql }));
  const statements = [
    ...rowsFor(
      current,
      desired,
      "DELETE FROM group_listings WHERE group_id = ? AND listing_id = ?",
    ),
    ...rowsFor(
      desired,
      current,
      "INSERT OR IGNORE INTO group_listings (group_id, listing_id) VALUES (?, ?)",
    ),
  ];
  if (statements.length > 0) await executeBatch(statements);
};

/**
 * Remove every listing from a group (used when the group is deleted).
 */
export const resetGroupListings = async (groupId: number): Promise<void> => {
  await execute("DELETE FROM group_listings WHERE group_id = ?", [groupId]);
};

/**
 * Every membership row for a group, carrying its `package_price` override and
 * per-package `quantity`. A `package_price` of 0 means "no override — use the
 * listing's base price"; `quantity` defaults to 1.
 */
export const getGroupPackagePrices = (
  groupId: number,
): Promise<GroupListing[]> =>
  queryAll<GroupListing>(
    "SELECT group_id, listing_id, package_price, quantity FROM group_listings WHERE group_id = ? ORDER BY listing_id ASC",
    [groupId],
  );

/** Reset every member's override to price 0 / quantity 1 (no override). */
const clearGroupPackageMembers = (groupId: number): Promise<unknown> =>
  execute(
    "UPDATE group_listings SET package_price = 0, quantity = 1 WHERE group_id = ?",
    [groupId],
  );

/**
 * Set the `package_price` and `quantity` on a group's membership rows in one
 * UPDATE. Listings named in `members` that are CURRENT members get their values;
 * every other member is reset to price 0 / quantity 1. Non-member ids are
 * dropped, so a stale or crafted id is ignored rather than wiping the real
 * overrides via the `ELSE` branches. An explicit empty array clears all
 * overrides; a non-empty list that matches no members is a no-op (it isn't
 * treated as "clear all"). One statement regardless of size, staying clear of
 * the round-trip guard.
 */
export const setGroupPackageMembers = async (
  groupId: number,
  members: PackageMemberInput[],
): Promise<void> => {
  if (members.length === 0) {
    await clearGroupPackageMembers(groupId);
    return;
  }
  const memberIds = new Set(await getGroupListingIds(groupId));
  const valid = members.filter((m) => memberIds.has(m.listingId));
  // A non-empty submission with no valid members is treated as a no-op rather
  // than a full wipe — only an explicit empty array clears overrides.
  if (valid.length === 0) return;
  const priceCases = valid.map(() => "WHEN ? THEN ?").join(" ");
  const qtyCases = valid.map(() => "WHEN ? THEN ?").join(" ");
  const args: number[] = [];
  for (const { listingId, price } of valid) args.push(listingId, price);
  for (const { listingId, quantity } of valid)
    args.push(listingId, quantity ?? 1);
  args.push(groupId);
  await execute(
    `UPDATE group_listings SET package_price = CASE listing_id ${priceCases} ELSE 0 END, quantity = CASE listing_id ${qtyCases} ELSE 1 END WHERE group_id = ?`,
    args,
  );
};

/**
 * Set the `active` flag on every listing in a group.
 * Returns the number of listings affected.
 */
export const setGroupListingsActive = async (
  groupId: number,
  active: boolean,
): Promise<number> => {
  // Unaliased `id` (not IN_GROUP_SQL's `listing.id`) — this UPDATE has no table
  // alias, so SQLite would reject `listing.id` here.
  const result = await execute(
    "UPDATE listings SET active = ? WHERE id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)",
    [active ? 1 : 0, groupId],
  );
  return result.rowsAffected;
};
