/**
 * Listing parent/child relationship editing (the "required child listings"
 * section on the listing edit page + its save endpoint).
 *
 * Behind the LISTING_PARENTS_ENABLED flag — off until the booking gate that
 * enforces the relationship ships (see parents.md release gate).
 */

import { t } from "#i18n";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { isListingParentsEnabled } from "#shared/config.ts";
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
import { edgeFieldError } from "#shared/listing-parents-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/** The data the edit page's "required children" section renders, or undefined
 * when the feature is disabled. `allListings` excludes the listing itself (no
 * self-edges); `childIds` are its currently-required children; `offeredUnder`
 * are the listings it is itself a child of. */
export type ListingParentsSection = {
  allListings: ListingWithCount[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
};

export const loadListingParentsSection = async (
  listingId: number,
): Promise<ListingParentsSection | undefined> => {
  if (!isListingParentsEnabled()) return undefined;
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
 * Reject a parent→children edge set that the inherited-date booking model can't
 * honour, returning a user-facing error (or null when every edge is allowed).
 * Combines the structural nesting blocks (single-level only — a parent can't be
 * a child, a child can't be a parent) with the shared per-edge field rules
 * ({@link edgeFieldError}: no renewal tiers, daily child needs a daily parent,
 * matching durations).
 *
 * An **empty** child set is always allowed: it clears (or no-ops) the listing's
 * edges, so a listing that is itself a child can still save its blank children
 * form, and a stuck nested state can be cleared.
 */
const childEdgeError = (
  parent: ListingWithCount,
  parentIsChild: boolean,
  children: { listing: ListingWithCount; isParent: boolean }[],
): string | null => {
  if (children.length === 0) return null;
  if (parentIsChild) {
    return t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
  }
  for (const { listing, isParent } of children) {
    if (isParent) {
      return t("listings_table.children_err_child_is_parent", {
        name: listing.name,
      });
    }
    const fieldError = edgeFieldError(parent, listing);
    if (fieldError) return fieldError;
  }
  return null;
};

/** Handle POST /admin/listing/:id/children (set the required child listings). */
export const handleAdminListingChildren: TypedRouteHandler<
  "POST /admin/listing/:id/children"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withEntityFromParam(id, getListingWithCount, async (listing) => {
      if (!isListingParentsEnabled()) return notFoundResponse();
      const byId = await getListingsById();
      // Drop self-edges and unknown ids.
      const childIds = form
        .getNumberArray("child_listing_ids")
        .filter((childId) => childId !== id && byId.has(childId));
      // Load nesting state: whether this listing is already a child, and which
      // chosen children are themselves parents.
      const [parentIds, ...childChildIds] = await Promise.all([
        getParentIds(id),
        ...childIds.map((childId) => getChildIds(childId)),
      ]);
      const children = childIds.map((childId, index) => ({
        isParent: childChildIds[index]!.length > 0,
        listing: byId.get(childId)!,
      }));
      const error = childEdgeError(listing, parentIds.length > 0, children);
      if (error) return redirect(`/admin/listing/${id}/edit`, error, false);
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
