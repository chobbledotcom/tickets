/**
 * Parent/child relationships between listings (the `listing_parents` table).
 *
 * An edge row means `child_listing_id` is a chooseable child of
 * `parent_listing_id`. Reads return the **relationship only** — never an
 * availability-filtered set: bookability is date/duration-specific, so callers
 * evaluate it at render/submit against the submitted date (see parents.md, the
 * relationship-accessor note and invariant I3).
 *
 * Only the accessors with a production consumer live here; the booking-page
 * batch loader and edit-on-child writer are added alongside the gate/booking
 * work that uses them, to keep the module free of unused exports.
 */

import { compact } from "#fp";
import {
  executeBatch,
  inPlaceholders,
  queryAll,
  queryIdColumn,
} from "#shared/db/client.ts";
import { getListingsById } from "#shared/db/listings.ts";
import {
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";

const INSERT_EDGE =
  "INSERT INTO listing_parents (parent_listing_id, child_listing_id) VALUES (?, ?)";

/** Of the given listing ids, the set that are a child of some parent (i.e. have
 * a `listing_parents` edge naming them as `child_listing_id`). Used to reject
 * child slugs at the booking entry point — a booking can never start from a
 * child (invariant I3). Returns an empty set for an empty input (no query). */
export const getChildListingIds = async (
  ids: readonly number[],
): Promise<Set<number>> => {
  if (ids.length === 0) return new Set();
  const rows = await queryIdColumn(
    `SELECT DISTINCT child_listing_id AS id FROM listing_parents WHERE child_listing_id IN (${inPlaceholders(
      ids,
    )})`,
    [...ids],
  );
  return new Set(rows);
};

/** Child listing ids that must be chosen under `parentId` (relationship only). */
export const getChildIds = (parentId: number): Promise<number[]> =>
  queryIdColumn(
    "SELECT child_listing_id AS id FROM listing_parents WHERE parent_listing_id = ? ORDER BY child_listing_id",
    [parentId],
  );

/** Parent listing ids that `childId` is offered under (relationship only). */
export const getParentIds = (childId: number): Promise<number[]> =>
  queryIdColumn(
    "SELECT parent_listing_id AS id FROM listing_parents WHERE child_listing_id = ? ORDER BY parent_listing_id",
    [childId],
  );

/** Replace the set of children required under `parentId` (admin edit-on-parent):
 * clear the parent's edges, then insert one per supplied child id. */
export const setChildIds = (
  parentId: number,
  childIds: readonly number[],
): Promise<void> =>
  executeBatch([
    {
      args: [parentId],
      sql: "DELETE FROM listing_parents WHERE parent_listing_id = ?",
    },
    ...childIds.map((childId) => ({
      args: [parentId, childId],
      sql: INSERT_EDGE,
    })),
  ]);

/**
 * The children of each of `parentIds`, hydrated to full rows (relationship
 * only — never availability-filtered; see invariant I3 and the module note).
 * One query for all edges (no N+1), then grouped by parent. Each parent's
 * children preserve child-id order and drop any that no longer exist; only
 * parents with at least one surviving child appear in the result map.
 */
export const getChildrenForParents = async (
  parentIds: readonly number[],
): Promise<Map<number, ListingWithCount[]>> => {
  if (parentIds.length === 0) return new Map();
  const rows = await queryAll<{ parent: number; child: number }>(
    `SELECT parent_listing_id AS parent, child_listing_id AS child
       FROM listing_parents
      WHERE parent_listing_id IN (${inPlaceholders(parentIds)})
      ORDER BY parent_listing_id, child_listing_id`,
    [...parentIds],
  );
  if (rows.length === 0) return new Map();
  const byId = await getListingsById();
  const result = new Map<number, ListingWithCount[]>();
  for (const { parent, child } of rows) {
    const listing = byId.get(child);
    if (!listing) continue;
    (result.get(parent) ?? result.set(parent, []).get(parent)!).push(listing);
  }
  return result;
};

/** The listings `childId` is offered under, hydrated to full rows (relationship
 * only; preserves id order and drops any that no longer exist). */
export const getParentsOf = async (
  childId: number,
): Promise<ListingWithCount[]> => {
  const ids = await getParentIds(childId);
  if (ids.length === 0) return [];
  const byId = await getListingsById();
  return compact(ids.map((id) => byId.get(id)));
};

/**
 * Re-validate every edge touching a listing against its *would-be* field values,
 * for a listing save (a type / duration / day-price / renewal-tier edit can
 * break an existing edge the booking gate then can't date or price). `updated`
 * carries the post-save fields with the listing's own id; the function checks it
 * as the parent of each of its children and as the child under each of its
 * parents, hydrating the opposite endpoints from the listings cache. Returns the
 * first incompatibility's user-facing error, or null when every edge still
 * holds (including when the listing has no edges).
 */
export const edgeIncompatibilityAfterChange = async (
  updated: EdgeListing,
): Promise<string | null> => {
  const [childIds, parentIds] = await Promise.all([
    getChildIds(updated.id),
    getParentIds(updated.id),
  ]);
  if (childIds.length === 0 && parentIds.length === 0) return null;
  const byId = await getListingsById();
  for (const childId of childIds) {
    const child = byId.get(childId);
    const error = child && edgeFieldError(updated, child);
    if (error) return error;
  }
  for (const parentId of parentIds) {
    const parent = byId.get(parentId);
    const error = parent && edgeFieldError(parent, updated);
    if (error) return error;
  }
  return null;
};
