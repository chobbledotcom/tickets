/**
 * Listing parent/child relationship editing (the "required child listings"
 * section on the listing edit page + its save endpoint).
 */

import { t } from "#i18n";
/* jscpd:ignore-start */
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getChildIds,
  getParentIds,
  getParentsOf,
  setChildIds,
} from "#shared/db/listing-parents.ts";
import {
  getAllListings,
  getListingsById,
  getListingWithCount,
} from "#shared/db/listings.ts";
import { childOnlyAddOnName } from "#shared/db/modifier-resolve.ts";
import {
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/** The data the edit page's "required children" section renders. `allListings`
 * excludes the listing itself (no self-edges); `childIds` are its
 * currently-required children; `offeredUnder` are the listings it is itself a
 * child of. */
export type ListingParentsSection = {
  allListings: ListingWithCount[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
};

export const loadListingParentsSection = async (
  listingId: number,
): Promise<ListingParentsSection> => {
  const [allListings, childIds, offeredUnder] = await Promise.all([
    getAllListings(),
    getChildIds(listingId),
    getParentsOf(listingId),
  ]);
  return {
    allListings: allListings.filter((l) => l.id !== listingId),
    childIds: new Set(childIds),
    offeredUnder,
  };
};

/**
 * Reject a parent→children edge set that the inherited-date booking model or the
 * v1 add-on scoping can't honour, returning a user-facing error (or null when
 * every edge is allowed). Combines the structural nesting blocks (single-level
 * only — a parent can't be a child, a child can't be a parent), the shared
 * per-edge field rules ({@link edgeFieldError}: no renewal tiers, daily child
 * needs a daily parent, matching durations), and the unsupported child-scoped
 * add-on hard block (a child that would carry an opt-in add-on reachable *only*
 * through the suppressed child — {@link childOnlyAddOnName}).
 *
 * An **empty** child set is always allowed: it clears (or no-ops) the listing's
 * edges, so a listing that is itself a child can still save its blank children
 * form, and a stuck nested state can be cleared.
 */
const childEdgeError = async (
  parent: EdgeListing,
  parentIsChild: boolean,
  children: { listing: ListingWithCount; isParent: boolean }[],
): Promise<string | null> => {
  if (children.length === 0) return null;
  if (parentIsChild) {
    return t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
  }
  // The parent's own direct booking page loads add-ons from ONLY its own
  // listing id (`getTicketContext` → `getOptionalAddOns([parent.id])`), never
  // its group siblings, so reachability is checked against just `[parent.id]`.
  const pageIds = [parent.id];
  for (const { listing, isParent } of children) {
    if (isParent) {
      return t("listings_table.children_err_child_is_parent", {
        name: listing.name,
      });
    }
    const fieldError = edgeFieldError(parent, listing);
    if (fieldError) return fieldError;
    // v1 has no child-scoped add-on render/parse path, so an add-on reachable
    // only through the suppressed child would become a dead end — hard block it.
    const addOn = await childOnlyAddOnName(listing.id, pageIds);
    if (addOn) {
      return t("listings_table.children_err_child_addon", {
        addon: addOn,
        name: listing.name,
      });
    }
  }
  return null;
};

/** The outcome of validating a parent's submitted child ids: either a
 * user-facing error, or the cleaned set of child ids ready to persist. */
export type ChildEdgeValidation =
  | { ok: false; error: string }
  | { ok: true; childIds: number[] };

/**
 * Shared child-edge diff + validation for the HTML form and the admin JSON API,
 * so both enforce one rule set. Drops self-edges and unknown ids from
 * `submittedChildIds`, loads the nesting state, and runs every block in
 * {@link childEdgeError} before reporting the cleaned ids the caller should
 * write with `setChildIds`.
 *
 * `parent` is an {@link EdgeListing} (not the full row) so the admin API can
 * validate a listing's **would-be** edge fields BEFORE the row is written
 * (atomicity — parents.md Fix 4): a create has no persisted row yet, and an
 * update's rename/type change must not persist when an edge is rejected. A
 * create passes a placeholder id (no real listing — and so no real edge — can
 * reference it, so the self-edge / nesting / add-on-reachability checks behave
 * exactly as for a not-yet-existing parent).
 */
export const validateChildEdges = async (
  parent: EdgeListing,
  submittedChildIds: readonly number[],
): Promise<ChildEdgeValidation> => {
  const byId = await getListingsById();
  // Drop self-edges and unknown ids.
  const childIds = submittedChildIds.filter(
    (childId) => childId !== parent.id && byId.has(childId),
  );
  // Load nesting state: whether this listing is already a child, and which
  // chosen children are themselves parents.
  const [parentIds, ...childChildIds] = await Promise.all([
    getParentIds(parent.id),
    ...childIds.map((childId) => getChildIds(childId)),
  ]);
  const children = childIds.map((childId, index) => ({
    isParent: childChildIds[index]!.length > 0,
    listing: byId.get(childId)!,
  }));
  const error = await childEdgeError(parent, parentIds.length > 0, children);
  return error ? { error, ok: false } : { childIds, ok: true };
};

/**
 * Copy a duplicated parent's required-child edges onto its new copy, **validated**
 * through the same {@link validateChildEdges} path the editor uses (the source was
 * valid, but stay consistent and never persist a rule-breaking edge). `childIds`
 * is the child set the copy should require — for a single-listing duplicate the
 * source parent's own children verbatim; for a group duplicate the source
 * parent's children remapped to the clones (intra-group) or kept (external).
 *
 * Callers only invoke this for a source that actually has children. When the
 * edge set fails validation it is **not** written (so a copy is never left with
 * an invalid gate) and the validation error is **returned** so the caller can
 * warn the operator (Fix 1) — a duplicate that silently drops its required-child
 * gate would turn a gated listing into a standalone bookable copy. Returns null
 * when the edges were copied successfully.
 *
 * The validation legitimately fails for a copy when an edge is reachable only
 * through the *source* (e.g. a child carrying an opt-in add-on scoped to
 * `{originalParent, child}` becomes a dead end from the new parent), so the
 * silent no-op this replaces hid a real gate loss.
 */
export const copyDuplicatedChildEdges = async (
  newParent: ListingWithCount,
  childIds: readonly number[],
): Promise<string | null> => {
  const result = await validateChildEdges(newParent, childIds);
  if (!result.ok) return result.error;
  await setChildIds(newParent.id, result.childIds);
  return null;
};

/** Write a parent's full child set (existing ∪ additions) through the validated
 * {@link copyDuplicatedChildEdges} path. `setChildIds` REPLACES a parent's edges,
 * so an external parent gaining a cloned child must keep its current children
 * too — otherwise remapping would clobber the original gate it already had. The
 * additions are freshly-cloned ids, always disjoint from the parent's existing
 * children, so a plain concatenation can't collide on the unique edge index. */
const addChildrenToParent = async (
  parentId: number,
  addChildIds: readonly number[],
): Promise<void> => {
  // The parent always loads (it is a real listing referenced by an existing edge).
  const parent = (await getListingWithCount(parentId))!;
  const existing = await getChildIds(parentId);
  await copyDuplicatedChildEdges(parent, [...existing, ...addChildIds]);
};

/**
 * Recreate the parent/child edges of a duplicated group on its clones. `idMap`
 * maps each source member's id to its clone. Two directions are walked so a
 * cloned child is never left standalone-bookable (the silent gate-drop Fix 2
 * guards against):
 *
 * 1. **Outgoing** — for every cloned member that is a parent, the clone requires
 *    the **remapped** child set: an intra-group child (a member of the same
 *    group) points at *its* clone, while a child living **outside** the group
 *    keeps referencing the original external listing so the clone still has a
 *    working gate.
 * 2. **Incoming** — for every cloned member that is a child whose parent is
 *    **outside** the group, recreate `outsideParent → clonedChild`, so the clone
 *    is still a child (absent from no standalone surface) rather than a standalone
 *    bookable listing. (A child whose parent is *inside* the group is already
 *    covered by the outgoing walk, which attaches it to the cloned parent.)
 *
 * Each remapped/added set is written through the validated
 * {@link copyDuplicatedChildEdges} path. A no-op when no cloned member touches an
 * edge.
 */
export const remapDuplicatedGroupEdges = async (
  idMap: ReadonlyMap<number, number>,
): Promise<void> => {
  // Direction 1: outgoing edges of each cloned parent.
  for (const [sourceId, newId] of idMap) {
    const sourceChildIds = await getChildIds(sourceId);
    if (sourceChildIds.length === 0) continue;
    const remapped = sourceChildIds.map(
      (childId) => idMap.get(childId) ?? childId,
    );
    // `newId` is a clone just inserted in this request, so it always loads.
    const newParent = (await getListingWithCount(newId))!;
    await copyDuplicatedChildEdges(newParent, remapped);
  }
  // Direction 2: incoming edges of each cloned child whose parent is OUTSIDE the
  // group (an inside parent is already handled above). Collect every
  // (outsideParent, cloneId) pair, then group by parent so one external parent
  // gaining several cloned children is written once (and its existing children
  // preserved).
  const outsidePairs: { parentId: number; cloneId: number }[] = [];
  for (const [sourceId, cloneId] of idMap) {
    const parentIds = await getParentIds(sourceId);
    for (const parentId of parentIds) {
      // A parent inside the group is handled by the outgoing walk above.
      if (!idMap.has(parentId)) outsidePairs.push({ cloneId, parentId });
    }
  }
  const byOutsideParent = Map.groupBy(outsidePairs, (pair) => pair.parentId);
  for (const [parentId, pairs] of byOutsideParent) {
    await addChildrenToParent(
      parentId,
      pairs.map((pair) => pair.cloneId),
    );
  }
};

/** Handle POST /admin/listing/:id/children (set the required child listings). */
export const handleAdminListingChildren: TypedRouteHandler<
  "POST /admin/listing/:id/children"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withEntityFromParam(id, getListingWithCount, async (listing) => {
      const result = await validateChildEdges(
        listing,
        form.getNumberArray("child_listing_ids"),
      );
      if (!result.ok) {
        return redirect(`/admin/listing/${id}/edit`, result.error, false);
      }
      const { childIds } = result;
      await setChildIds(id, childIds);
      await logActivity(
        `Listing '${listing.name}' required children set to ${childIds.length} listing${
          childIds.length === 1 ? "" : "s"
        }`,
        listing,
      );
      return redirect(
        `/admin/listing/${id}/edit`,
        "Required children updated",
        true,
      );
    }),
  );
