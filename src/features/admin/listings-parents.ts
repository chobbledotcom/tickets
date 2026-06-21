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
import {
  availableDayCounts,
  dayPriceFor,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
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

type EdgeListing = Pick<
  ListingWithCount,
  | "id"
  | "name"
  | "listing_type"
  | "months_per_unit"
  | "customisable_days"
  | "duration_days"
  | "day_prices"
>;

/** A fixed-duration parent's single resolved booking span (days): its own
 * `duration_days` for a daily listing, otherwise 1. Only meaningful for a
 * non-`customisable_days` parent (a customisable parent has a *range*, queried
 * via {@link availableDayCounts}). */
const parentFixedDuration = (parent: EdgeListing): number =>
  parent.listing_type === "daily"
    ? normalizeDurationDays(parent.duration_days)
    : 1;

/**
 * Whether `child`'s booking span can match the duration it inherits from
 * `parent` (a child has no day controls of its own — it takes the base unit's).
 * A non-customisable child has a single fixed span (its `duration_days` for a
 * daily child, else 1); a customisable child must price the inherited span. The
 * parent supplies either a fixed span or — when customisable — a range of
 * selectable spans, and the edge is honourable iff the spans can agree.
 */
const durationsCompatible = (
  parent: EdgeListing,
  child: EdgeListing,
): boolean => {
  if (child.customisable_days) {
    if (parent.customisable_days) {
      const childCounts = new Set(availableDayCounts(child));
      return availableDayCounts(parent).some((days) => childCounts.has(days));
    }
    return dayPriceFor(child, parentFixedDuration(parent)) !== null;
  }
  const childDuration =
    child.listing_type === "daily"
      ? normalizeDurationDays(child.duration_days)
      : 1;
  return parent.customisable_days
    ? availableDayCounts(parent).includes(childDuration)
    : childDuration === parentFixedDuration(parent);
};

/**
 * Reject a parent→children edge set that the inherited-date booking model can't
 * honour, returning a user-facing error (or null when every edge is allowed).
 * Enforces the statically-clear admin hard blocks: no renewal tiers on either
 * side, single-level only (no nesting), a daily child needs a daily parent, and
 * the child's booking span must match the duration it inherits from the parent.
 *
 * An **empty** child set is always allowed: it clears (or no-ops) the listing's
 * edges, so a listing that is itself a child can still save its blank children
 * form, and a stuck nested state can be cleared.
 */
const childEdgeError = (
  parent: EdgeListing,
  parentIsChild: boolean,
  children: { listing: EdgeListing; isParent: boolean }[],
): string | null => {
  if (children.length === 0) return null;
  if (parent.months_per_unit > 0) {
    return t("listings_table.children_err_parent_renewal", {
      name: parent.name,
    });
  }
  if (parentIsChild) {
    return t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
  }
  for (const { listing, isParent } of children) {
    if (listing.months_per_unit > 0) {
      return t("listings_table.children_err_child_renewal", {
        name: listing.name,
      });
    }
    if (isParent) {
      return t("listings_table.children_err_child_is_parent", {
        name: listing.name,
      });
    }
    if (listing.listing_type === "daily" && parent.listing_type !== "daily") {
      return t("listings_table.children_err_child_daily", {
        name: listing.name,
      });
    }
    if (!durationsCompatible(parent, listing)) {
      return t("listings_table.children_err_child_duration", {
        name: listing.name,
      });
    }
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
