/**
 * Parent/child relationships between listings (the `listing_parents` table).
 *
 * An edge row means `child_listing_id` is a chooseable child of
 * `parent_listing_id`. Reads return the **relationship only** — never an
 * availability-filtered set: bookability is date/duration-specific, so callers
 * evaluate it at render/submit against the submitted date.
 *
 * Only accessors with a production consumer live here; the booking-page batch
 * loader and edit-on-child writer are added alongside the gate/booking work that
 * uses them, to keep the module free of unused exports.
 */

import { mapNotNullish } from "#fp";
import { inPlaceholders, queryAll, queryIdColumn } from "#shared/db/client.ts";
import { linkTableSide } from "#shared/db/link-table.ts";
import { getListingsById } from "#shared/db/listings.ts";
import {
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** A parent's chooseable children, keyed by parent id (relationship only):
 * `getIds` reads them ascending; `setIds`/`setIdsTx` replace the set (the
 * admin edit-on-parent save — the Tx form runs on the caller's transaction so
 * the edges commit atomically with the listing row write). */
export const listingChildren = linkTableSide(
  "listing_parents",
  "parent_listing_id",
  "child_listing_id",
);

/** The parents a child is offered under, keyed by child id — the reverse
 * side. `addIdsTx` is the catalog-import writer for a freshly-created listing
 * that is a child of already-existing parents: additive (never a group-wide
 * delete), so it can't disturb a parent's other children the way a
 * `listingChildren.setIdsTx` replace would. */
export const listingParents = linkTableSide(
  "listing_parents",
  "child_listing_id",
  "parent_listing_id",
);

/** Run a child-id-selecting query (whose SQL embeds an `IN (…)` placeholder list
 * over `ids`) and return its results as a set. Empty input short-circuits to an
 * empty set with no query — the shared shape of the child-id lookups below. */
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
 * child. Returns an empty set for an empty input (no query). */
export const getChildListingIds = (
  ids: readonly number[],
): Promise<Set<number>> =>
  childIdSet(
    `SELECT DISTINCT child_listing_id AS id FROM listing_parents WHERE child_listing_id IN (${inPlaceholders(
      ids,
    )})`,
    ids,
  );

/** Of the given listing ids, the set that are a child AND are NOT sold on their
 * own (`listings.bookable_alone = 0`). This is the narrowed gate predicate: a
 * child flagged `bookable_alone` keeps its standalone booking page / catalog
 * entry / API eligibility, so it is excluded here even though it still has
 * parent edges. `getChildListingIds` (the unfiltered set) stays the STRUCTURAL
 * predicate — "renders under a parent, folds, carries allocations" — while this
 * one answers the GATE question "has no standalone existence". Returns an empty
 * set for empty input (no query). */
export const getNonStandaloneChildIds = (
  ids: readonly number[],
): Promise<Set<number>> =>
  childIdSet(
    `SELECT DISTINCT listingParent.child_listing_id AS id
       FROM listing_parents AS listingParent
       JOIN listings AS listing ON listing.id = listingParent.child_listing_id
      WHERE listingParent.child_listing_id IN (${inPlaceholders(ids)})
        AND listing.bookable_alone = 0`,
    ids,
  );

/** Whether any of `ids` is a child with no standalone existence (see
 * {@link getNonStandaloneChildIds}). The gate the explicit-slug entry points
 * (multi-slug `/ticket/<slugs>`, the signed QR, the JSON API book) use to reject
 * a child handed directly: a `bookable_alone` child is NOT counted, so its own
 * booking page / API lookup is allowed through. Empty input short-circuits to
 * false (no query). */
export const anyNonStandaloneChild = async (
  ids: readonly number[],
): Promise<boolean> => (await getNonStandaloneChildIds(ids)).size > 0;

type EdgeColumn = "child_listing_id" | "parent_listing_id";

/**
 * Batch-load `listing_parents` edges filtered by one endpoint and grouped,
 * hydrated, by the opposite one. `keyColumn` is matched against `ids` and keys
 * the result map; `valueColumn` is the opposite endpoint hydrated to full rows
 * (preserving id order, dropping any that no longer exist). One query (no N+1);
 * only keys with at least one surviving listing appear. Shared by {@link
 * getChildrenForParents} and {@link getParentsForChildren} so the two directions
 * never drift. (Column names come from the fixed {@link EdgeColumn} union, never
 * user input, so the interpolation is safe.)
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
 * only — never availability-filtered; see the module note).
 * Each parent's children preserve child-id order and drop any that no longer
 * exist; only parents with at least one surviving child appear in the result.
 */
export const getChildrenForParents = (
  parentIds: readonly number[],
): Promise<Map<number, ListingWithCount[]>> =>
  groupEdges(parentIds, "parent_listing_id", "child_listing_id");

/**
 * The parents of each of `childIds`, hydrated to full rows (relationship only —
 * never availability-filtered; see the module note). The
 * reverse of {@link getChildrenForParents}, used by discovery to decide whether
 * a child has any **bookable** parent that can offer it as an add-on
 * for public listing cards.
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
  const ids = await listingParents.getIds(childId);
  if (ids.length === 0) return [];
  const byId = await getListingsById();
  return mapNotNullish((id: number) => byId.get(id))(ids);
};

/** Both sides of every edge a listing participates in: its children and the
 * parents it is offered under. The shared first step of {@link
 * firstTouchingEdgeError}, the traversal both save-time re-checks run through;
 * also reused to reject parent/child listings as package members. */
/** The parent/child edge ids touching EACH of `listingIds`, loaded with two
 * batched queries (never per-listing). Every requested id gets an entry (empty
 * arrays when untouched), so callers index without a fallback. */
export const edgeIdsTouchingMany = async (
  listingIds: readonly number[],
): Promise<Map<number, { childIds: number[]; parentIds: number[] }>> => {
  const [childrenByParent, parentsByChild] = await Promise.all([
    getChildrenForParents(listingIds),
    getParentsForChildren(listingIds),
  ]);
  return new Map(
    listingIds.map((id) => [
      id,
      {
        childIds: (childrenByParent.get(id) ?? []).map((l) => l.id),
        parentIds: (parentsByChild.get(id) ?? []).map((l) => l.id),
      },
    ]),
  );
};

export const edgeIdsTouching = async (
  listingId: number,
): Promise<{ childIds: number[]; parentIds: number[] }> =>
  (await edgeIdsTouchingMany([listingId])).get(listingId)!;

/** One directed edge touching the saved listing, with the saved listing's own id
 * fixed on one side (the caller closes over it): `self: "parent"` means it is the
 * parent of `otherId` (one of its children); `self: "child"` means it is the
 * child under `otherId` (one of its parents). */
export type TouchingEdge = {
  self: "parent" | "child";
  otherId: number;
};

/**
 * Re-validate every parent/child edge touching a listing on save, returning the
 * first edge's user-facing error (or null when every edge holds, including when
 * the listing has none). The shared traversal for both save-time re-checks
 * (field compatibility and add-on reachability): it runs `check` over the
 * listing as **parent** of each of its children and as **child** under each of
 * its parents, stopping at the first error. `check` receives each {@link
 * TouchingEdge} (self on the fixed side, opposite endpoint as `otherId`) and
 * resolves whatever rows/scopes it needs itself, so the two callers can't drift
 * on which edges they walk or in what order.
 */
export const firstTouchingEdgeError = async (
  listingId: number,
  check: (edge: TouchingEdge) => string | null | Promise<string | null>,
): Promise<string | null> => {
  const { childIds, parentIds } = await edgeIdsTouching(listingId);
  const edges: TouchingEdge[] = [
    ...childIds.map((otherId): TouchingEdge => ({ otherId, self: "parent" })),
    ...parentIds.map((otherId): TouchingEdge => ({ otherId, self: "child" })),
  ];
  for (const edge of edges) {
    const error = await check(edge);
    if (error) return error;
  }
  return null;
};

/**
 * Re-validate every edge touching a listing against its *would-be* field values,
 * for a listing save (a type / duration / day-price / renewal-tier edit can
 * break an existing edge the booking gate then can't date or price). `updated`
 * carries the post-save fields with the listing's own id; opposite endpoints are
 * hydrated from the listings cache. Returns the first incompatibility's
 * user-facing error, or null when every edge still holds (including no edges).
 */
export const edgeIncompatibilityAfterChange = async (
  updated: EdgeListing,
): Promise<string | null> => {
  const byId = await getListingsById();
  return firstTouchingEdgeError(updated.id, ({ self, otherId }) => {
    // edgeIdsTouching hydrates through the same listings cache, dropping any
    // edge whose opposite endpoint no longer exists — so `other` always
    // resolves here.
    const other = byId.get(otherId)!;
    // `updated` stays on its fixed side: parent of each child, child under each parent.
    return self === "parent"
      ? edgeFieldError(updated, other)
      : edgeFieldError(other, updated);
  });
};
