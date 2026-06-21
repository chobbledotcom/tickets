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
import { executeBatch, queryIdColumn } from "#shared/db/client.ts";
import { getListingsById } from "#shared/db/listings.ts";
import type { ListingWithCount } from "#shared/types.ts";

const INSERT_EDGE =
  "INSERT INTO listing_parents (parent_listing_id, child_listing_id) VALUES (?, ?)";

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
