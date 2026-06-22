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

/** Run a child-id-selecting query (whose SQL embeds an `IN (…)` placeholder list
 * over `ids`) and return its results as a set. Short-circuits to an empty set —
 * and no query — for an empty input, the shared shape of the child-id lookups
 * below. */
const childIdSet = async (
  sql: string,
  ids: readonly number[],
): Promise<Set<number>> => {
  if (ids.length === 0) return new Set();
  return new Set(await queryIdColumn(sql, [...ids]));
};

/** Of the given listing ids, the set that are a child of some parent (i.e. have
 * a `listing_parents` edge naming them as `child_listing_id`). Used to reject
 * child slugs at the booking entry point — a booking can never start from a
 * child (invariant I3). Returns an empty set for an empty input (no query). */
export const getChildListingIds = (
  ids: readonly number[],
): Promise<Set<number>> =>
  childIdSet(
    `SELECT DISTINCT child_listing_id AS id FROM listing_parents WHERE child_listing_id IN (${inPlaceholders(
      ids,
    )})`,
    ids,
  );

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

type EdgeColumn = "child_listing_id" | "parent_listing_id";

/**
 * Batch-load `listing_parents` edges filtered by one endpoint and grouped,
 * hydrated, by the opposite one. `keyColumn` is matched against `ids` and used
 * as the result-map key; `valueColumn` is the opposite endpoint hydrated to full
 * rows (preserving id order, dropping any that no longer exist). One query (no
 * N+1); only keys with at least one surviving listing appear. Shared by
 * {@link getChildrenForParents} and {@link getParentsForChildren} so the two
 * directions never drift. (Column names come from the fixed {@link EdgeColumn}
 * union, never user input, so the interpolation is safe.)
 */
const groupEdges = async (
  ids: readonly number[],
  keyColumn: EdgeColumn,
  valueColumn: EdgeColumn,
): Promise<Map<number, ListingWithCount[]>> => {
  const result = new Map<number, ListingWithCount[]>();
  if (ids.length === 0) return result;
  const byId = await getListingsById();
  const rows = await queryAll<{ key: number; value: number }>(
    `SELECT ${keyColumn} AS key, ${valueColumn} AS value
       FROM listing_parents
      WHERE ${keyColumn} IN (${inPlaceholders(ids)})
      ORDER BY ${keyColumn}, ${valueColumn}`,
    [...ids],
  );
  for (const { key, value } of rows) {
    const listing = byId.get(value);
    if (!listing) continue;
    (result.get(key) ?? result.set(key, []).get(key)!).push(listing);
  }
  return result;
};

/**
 * The children of each of `parentIds`, hydrated to full rows (relationship
 * only — never availability-filtered; see invariant I3 and the module note).
 * Each parent's children preserve child-id order and drop any that no longer
 * exist; only parents with at least one surviving child appear in the result.
 */
export const getChildrenForParents = (
  parentIds: readonly number[],
): Promise<Map<number, ListingWithCount[]>> =>
  groupEdges(parentIds, "parent_listing_id", "child_listing_id");

/**
 * The parents of each of `childIds`, hydrated to full rows (relationship only —
 * never availability-filtered; see invariant I3 and the module note). The
 * reverse of {@link getChildrenForParents}, used by discovery to decide whether
 * a child has any **bookable** parent that can offer it as an add-on
 * (parents.md, "Public listing cards").
 */
export const getParentsForChildren = (
  childIds: readonly number[],
): Promise<Map<number, ListingWithCount[]>> =>
  groupEdges(childIds, "child_listing_id", "parent_listing_id");

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
