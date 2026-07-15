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

import { mapNotNullish, unique } from "#fp";
import { inPlaceholders, queryIdColumn } from "#shared/db/client.ts";
import { type LinkTableSide, linkTableSide } from "#shared/db/link-table.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
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

/** The requested listing ids that have at least one link on a relationship
 * side. The side's batched map includes empty keys; structural child checks need
 * only the keys whose parent-id list is non-empty. */
export const listingIdsWithLinks = (
  links: ReadonlyMap<number, readonly number[]>,
): Set<number> =>
  new Set(
    [...links].flatMap(([id, linkedIds]) => (linkedIds.length > 0 ? [id] : [])),
  );

/** Of the given listing ids, the set that are a child AND are NOT sold on their
 * own (`listings.bookable_alone = 0`). This is the narrowed gate predicate: a
 * child flagged `bookable_alone` keeps its standalone booking page / catalog
 * entry / API eligibility, so it is excluded here even though it still has
 * parent edges. `listingParents` (the unfiltered side) stays the STRUCTURAL
 * predicate — "renders under a parent, folds, carries allocations" — while this
 * one answers the GATE question "has no standalone existence". Returns an empty
 * set for empty input (no query). */
export const getNonStandaloneChildIds = async (
  ids: readonly number[],
): Promise<Set<number>> =>
  ids.length === 0
    ? new Set()
    : new Set(
        await queryIdColumn(
          `SELECT DISTINCT listingParent.child_listing_id AS id
             FROM listing_parents AS listingParent
             JOIN listings AS listing ON listing.id = listingParent.child_listing_id
            WHERE listingParent.child_listing_id IN (${inPlaceholders(ids)})
              AND listing.bookable_alone = 0`,
          [...ids],
        ),
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

export type HydratedListingLinks = {
  idsByKey: Map<number, number[]>;
  listingsByKey: Map<number, ListingWithCount[]>;
};

export type ParentAndChildLinkMaps = {
  childIdsByParent: Map<number, number[]>;
  childrenByParent: Map<number, ListingWithCount[]>;
  parentIdsByChild: Map<number, number[]>;
  parentsByChild: Map<number, ListingWithCount[]>;
};

const listingsForLinks = (
  idsByKey: ReadonlyMap<number, readonly number[]>,
  byId: ReadonlyMap<number, ListingWithCount>,
): Map<number, ListingWithCount[]> =>
  new Map(
    [...idsByKey]
      .toSorted(([left], [right]) => left - right)
      .flatMap(([key, ids]) => {
        const linked = mapNotNullish((id: number) => byId.get(id))(ids);
        return linked.length > 0 ? [[key, linked] as const] : [];
      }),
  );

/** Load only the listings named by one or more relationship maps. */
const listingsByIdFor = async (
  sides: readonly ReadonlyMap<number, readonly number[]>[],
): Promise<Map<number, ListingWithCount>> => {
  const linkedIds = unique(
    sides.flatMap((links) => [...links.values()].flat()),
  );
  const listings = await getListingsWithCountsByIds(linkedIds);
  return new Map(listings.map((listing) => [listing.id, listing]));
};

/** Batch and hydrate one listing relationship side. Only linked listings are
 * loaded, and hydrated values preserve ascending relationship order. Empty keys
 * and keys whose linked listings no longer exist are omitted from
 * `listingsByKey`, matching the old parent/child row loaders. */
export const hydrateListingLinks = async (
  side: LinkTableSide,
  keyIds: readonly number[],
): Promise<HydratedListingLinks> => {
  const idsByKey = await side.getIdsByKeys(keyIds);
  return {
    idsByKey,
    listingsByKey: listingsForLinks(
      idsByKey,
      await listingsByIdFor([idsByKey]),
    ),
  };
};

/** Load both directions in three bounded queries and return named maps, so a
 * caller cannot swap parent and child results. */
export const loadParentAndChildLinks = async (
  keyIds: readonly number[],
): Promise<ParentAndChildLinkMaps> => {
  const [childIdsByParent, parentIdsByChild] = await Promise.all([
    listingChildren.getIdsByKeys(keyIds),
    listingParents.getIdsByKeys(keyIds),
  ]);
  const byId = await listingsByIdFor([childIdsByParent, parentIdsByChild]);
  return {
    childIdsByParent,
    childrenByParent: listingsForLinks(childIdsByParent, byId),
    parentIdsByChild,
    parentsByChild: listingsForLinks(parentIdsByChild, byId),
  };
};

/** One directed edge touching the saved listing, with the saved listing's own id
 * fixed on one side (the caller closes over it): `self: "parent"` means it is the
 * parent of `otherId` (one of its children); `self: "child"` means it is the
 * child under `otherId` (one of its parents). */
export type TouchingEdge = {
  self: "parent" | "child";
  otherId: number;
};

type TouchingEdgeCheck = (
  edge: TouchingEdge,
) => string | null | Promise<string | null>;

const checkTouchingEdges = async (
  childIds: readonly number[],
  parentIds: readonly number[],
  check: TouchingEdgeCheck,
): Promise<string | null> => {
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
  check: TouchingEdgeCheck,
): Promise<string | null> => {
  const [childIds, parentIds] = await Promise.all([
    listingChildren.getIds(listingId),
    listingParents.getIds(listingId),
  ]);
  return checkTouchingEdges(childIds, parentIds, check);
};

/**
 * Re-validate every edge touching a listing against its *would-be* field values,
 * for a listing save (a type / duration / day-price / renewal-tier edit can
 * break an existing edge the booking gate then can't date or price). `updated`
 * carries the post-save fields with the listing's own id; opposite endpoints are
 * loaded by their linked ids. Returns the first incompatibility's
 * user-facing error, or null when every edge still holds (including no edges).
 */
export const edgeIncompatibilityAfterChange = async (
  updated: EdgeListing,
): Promise<string | null> => {
  const { childrenByParent, parentsByChild } = await loadParentAndChildLinks([
    updated.id,
  ]);
  const children = childrenByParent.get(updated.id) ?? [];
  const parents = parentsByChild.get(updated.id) ?? [];
  const byId = new Map(
    [...children, ...parents].map((listing) => [listing.id, listing]),
  );
  return checkTouchingEdges(
    children.map((listing) => listing.id),
    parents.map((listing) => listing.id),
    ({ self, otherId }) => {
      const other = byId.get(otherId)!;
      // `updated` stays on its fixed side: parent of each child, child under each parent.
      return self === "parent"
        ? edgeFieldError(updated, other)
        : edgeFieldError(other, updated);
    },
  );
};
