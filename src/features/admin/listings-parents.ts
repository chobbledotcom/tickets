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
import { edgeFieldError } from "#shared/listing-parents-rules.ts";
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
  parent: ListingWithCount,
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
 */
export const validateChildEdges = async (
  parent: ListingWithCount,
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
 * Callers only invoke this for a source that actually has children; an edge set
 * that fails validation is skipped (not written), so a copy is never left with
 * an invalid gate.
 */
export const copyDuplicatedChildEdges = async (
  newParent: ListingWithCount,
  childIds: readonly number[],
): Promise<void> => {
  const result = await validateChildEdges(newParent, childIds);
  if (result.ok) await setChildIds(newParent.id, result.childIds);
};

/**
 * Recreate the parent/child edges of a duplicated group on its clones. `idMap`
 * maps each source member's id to its clone. For every source member that is a
 * parent, the clone requires the **remapped** child set: an intra-group child
 * (a member of the same group) points at *its* clone, while a child living
 * **outside** the group keeps referencing the original external listing so the
 * clone still has a working gate. A child member whose parent is outside the
 * group is *not* auto-attached (we only walk the cloned parents). Each remapped
 * set is written through the validated {@link copyDuplicatedChildEdges} path.
 *
 * A no-op when no cloned member is a parent.
 */
export const remapDuplicatedGroupEdges = async (
  idMap: ReadonlyMap<number, number>,
): Promise<void> => {
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
