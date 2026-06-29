/**
 * Listing parent/child relationship editing (the "required child listings"
 * section on the listing edit page + its save endpoint).
 */

import { unique } from "#fp";
import { t } from "#i18n";
/* jscpd:ignore-start */
import { CONTENT_FORM, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { logActivity } from "#shared/db/activityLog.ts";
import {
  anyPackageGroup,
  getGroupIdsByListingId,
  getGroupIdsByListingIds,
} from "#shared/db/groups.ts";
import {
  getChildIds,
  getChildrenForParents,
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
  childOnlyAddOnName,
  childOnlyAddOnNameForListings,
  type ListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
import {
  type EdgeListing,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/** A selectable child candidate on the edit page's "required children" list: the
 * listing plus why it can't be a child of the one being edited (null when it
 * can). Ineligible candidates are pre-disabled (unless already ticked) so the
 * operator can't build an edge the save would only reject (usability #4). */
export type ChildCandidate = {
  listing: ListingWithCount;
  ineligibleReason: string | null;
};

/** The data the edit page's "required children" section renders. `candidates`
 * excludes the listing itself (no self-edges) and carries each one's
 * eligibility; `childIds` are its currently-required children; `offeredUnder` are
 * the listings it is itself a child of. */
export type ListingParentsSection = {
  candidates: ChildCandidate[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
};

/** Why `candidate` can't be a child of `parent` for the edit-page candidate list,
 * or null when allowed — the synchronous structural + field blocks, mirroring
 * {@link childEdgeError} so the pre-disable and the save agree. The async
 * add-on-reachability block is left to the save: it needs per-edge scope
 * resolution and is the rare case. */
const childEdgeIneligibility = (
  parent: EdgeListing,
  candidate: EdgeListing,
  parentIsChild: boolean,
  candidateIsParent: boolean,
): string | null => {
  if (parentIsChild) {
    return t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
  }
  if (candidateIsParent) {
    return t("listings_table.children_err_child_is_parent", {
      name: candidate.name,
    });
  }
  return edgeFieldError(parent, candidate);
};

export const loadListingParentsSection = async (
  listing: ListingWithCount,
): Promise<ListingParentsSection> => {
  const [allListings, childIds, offeredUnder] = await Promise.all([
    getAllListings(),
    getChildIds(listing.id),
    getParentsOf(listing.id),
  ]);
  const others = allListings.filter((other) => other.id !== listing.id);
  // Single-level nesting: a listing already offered as a child can't also be a
  // parent, so every candidate is ineligible in that case.
  const parentIsChild = offeredUnder.length > 0;
  // One query for which candidates are themselves parents (so can't be a child),
  // instead of an N+1 over each candidate's children.
  const childrenOf = await getChildrenForParents(
    others.map((other) => other.id),
  );
  const candidates = others.map((candidate) => ({
    ineligibleReason: childEdgeIneligibility(
      listing,
      candidate,
      parentIsChild,
      (childrenOf.get(candidate.id)?.length ?? 0) > 0,
    ),
    listing: candidate,
  }));
  return { candidates, childIds: new Set(childIds), offeredUnder };
};

/** Resolve the name of an opt-in add-on that `childId` would orphan from a
 * parent page of `pageIds`, or null. The default resolves add-on scopes from the
 * LIVE listings table (the HTML children form, where the parent row's `group_id`
 * is already persisted); the admin API supplies a would-be variant that resolves
 * against an in-memory listing set carrying the submitted `group_id` (Fix 4). */
type ChildOnlyAddOnResolver = (
  childId: number,
  pageIds: readonly number[],
) => Promise<string | null>;

/**
 * Reject a parent→children edge set that the inherited-date booking model or the
 * v1 add-on scoping can't honour, returning a user-facing error (or null when
 * every edge is allowed). Combines the structural nesting blocks (single-level
 * only — a parent can't be a child, a child can't be a parent), the shared
 * per-edge field rules ({@link edgeFieldError}: no renewal tiers, daily child
 * needs a daily parent, matching durations), and the unsupported child-scoped
 * add-on hard block (a child carrying an opt-in add-on reachable *only* through
 * the suppressed child — {@link childOnlyAddOnName}).
 *
 * An **empty** child set is always allowed: it clears (or no-ops) the listing's
 * edges, so a listing that is itself a child can still save its blank children
 * form, and a stuck nested state can be cleared.
 */
const childEdgeError = async (
  parent: EdgeListing,
  parentIsChild: boolean,
  children: { listing: ListingWithCount; isParent: boolean }[],
  resolveChildOnlyAddOn: ChildOnlyAddOnResolver,
): Promise<string | null> => {
  if (children.length === 0) return null;
  if (parentIsChild) {
    return t("listings_table.children_err_parent_is_child", {
      name: parent.name,
    });
  }
  // The parent's own booking page loads add-ons from ONLY its own listing id
  // (`getTicketContext` → `getOptionalAddOns([parent.id])`), never its group
  // siblings, so reachability is checked against just `[parent.id]`.
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
    const addOn = await resolveChildOnlyAddOn(listing.id, pageIds);
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
 * Optional would-be group context for the admin JSON API (Fix 4): the parent's
 * submitted `group_id`, applied to an in-memory listing set so a group-scoped
 * add-on's reachability is resolved against the move the save is about to make
 * (the live `modifier_groups`→`listings` join can't yet see it). Omitted by the
 * HTML children form, whose parent row already carries its live `group_id`.
 */
export type ChildEdgeOptions = { wouldBeGroupIds: number[] };

/** Build the add-on resolver for a child-edge validation: the live-table check
 * for the HTML form, or the in-memory would-be-group check for the admin API
 * (Fix 4), mirroring {@link orphanedAddOnAfterChange}'s would-be approach.
 *
 * The would-be set carries the parent at its **submitted** `group_id`: an
 * existing parent is remapped in place; a not-yet-created parent (placeholder id)
 * is **appended** so it sits in that group too — otherwise a group-scoped
 * add-on's in-memory scope (the group's member listings) wouldn't include the new
 * parent and the add-on would look unreachable from its page, wrongly rejecting a
 * create into the add-on's own group. */
const childOnlyAddOnResolver = async (
  parent: EdgeListing,
  options: ChildEdgeOptions | undefined,
): Promise<ChildOnlyAddOnResolver> => {
  if (!options) return childOnlyAddOnName;
  const live = await getAllListings();
  const membership = await getGroupIdsByListingIds(live.map((l) => l.id));
  const hasParent = live.some((listing) => listing.id === parent.id);
  const base: ListingGroupMembership[] = live.map((listing) => ({
    active: listing.active,
    groupIds:
      listing.id === parent.id
        ? options.wouldBeGroupIds
        : (membership.get(listing.id) ?? []),
    id: listing.id,
  }));
  // On create the parent row doesn't exist in `live` yet, so append a
  // placeholder carrying its would-be group set (active — it serves a page).
  const allListings: ListingGroupMembership[] = hasParent
    ? base
    : [
        ...base,
        { active: true, groupIds: options.wouldBeGroupIds, id: parent.id },
      ];
  return (childId, pageIds) =>
    childOnlyAddOnNameForListings(childId, pageIds, allListings);
};

/**
 * Shared child-edge diff + validation for the HTML form and the admin JSON API,
 * so both enforce one rule set. Drops self-edges and unknown ids, loads the
 * nesting state, and runs every block in {@link childEdgeError} before reporting
 * the cleaned ids the caller should write with `setChildIds`.
 *
 * `parent` is an {@link EdgeListing} (not the full row) so the admin API can
 * validate **would-be** edge fields BEFORE the row is written (atomicity —
 * parents.md Fix 4): a create has no persisted row yet, and an update's
 * rename/type change must not persist when an edge is rejected. A create passes
 * a placeholder id (no real listing can reference it, so the self-edge / nesting
 * / add-on-reachability checks behave as for a not-yet-existing parent).
 */
export const validateChildEdges = async (
  parent: EdgeListing,
  submittedChildIds: readonly number[],
  options?: ChildEdgeOptions,
): Promise<ChildEdgeValidation> => {
  const byId = await getListingsById();
  // Drop self-edges and unknown ids, then collapse duplicates (preserving order):
  // a repeated child id (API body `[7,7]` or repeated form values) would make
  // `setChildIds` insert two `(parent, child)` rows and violate the unique index
  // — and on the API side-effect path that happens AFTER the row write, a partial
  // change (Fix 4). Dedupe once here so validation and persist agree.
  const childIds = unique(
    submittedChildIds.filter(
      (childId) => childId !== parent.id && byId.has(childId),
    ),
  );
  // Nesting state: whether this listing is already a child (parentIds), and
  // which chosen children are themselves parents (childChildIds).
  const [parentIds, resolveChildOnlyAddOn, ...childChildIds] =
    await Promise.all([
      getParentIds(parent.id),
      childOnlyAddOnResolver(parent, options),
      ...childIds.map((childId) => getChildIds(childId)),
    ]);
  const children = childIds.map((childId, index) => ({
    isParent: childChildIds[index]!.length > 0,
    listing: byId.get(childId)!,
  }));
  const error = await childEdgeError(
    parent,
    parentIds.length > 0,
    children,
    resolveChildOnlyAddOn,
  );
  return error ? { error, ok: false } : { childIds, ok: true };
};

/**
 * Copy a duplicated parent's required-child edges onto its new copy, **validated**
 * through the same {@link validateChildEdges} path the editor uses (the source was
 * valid, but stay consistent and never persist a rule-breaking edge). `childIds`
 * is the child set the copy should require — for a single-listing duplicate the
 * source's children verbatim; for a group duplicate they are remapped to the
 * clones (intra-group) or kept (external).
 *
 * On validation failure the edge set is **not** written (so a copy is never left
 * with an invalid gate) and the error is **returned** so the caller can warn the
 * operator (Fix 1) — a duplicate that silently drops its required-child gate
 * would turn a gated listing into a standalone bookable copy. Returns null on
 * success.
 *
 * Validation legitimately fails for a copy when an edge is reachable only through
 * the *source* (e.g. a child carrying an opt-in add-on scoped to
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
 * too — otherwise remapping would clobber the gate it already had. The additions
 * are freshly-cloned ids, always disjoint from the existing children, so a plain
 * concatenation can't collide on the unique edge index. Returns the validation
 * error (propagated for the group-duplicate warning, Fix 5) or null. */
const addChildrenToParent = async (
  parentId: number,
  addChildIds: readonly number[],
): Promise<string | null> => {
  // The parent always loads (it is a real listing referenced by an existing edge).
  const parent = (await getListingWithCount(parentId))!;
  const existing = await getChildIds(parentId);
  return copyDuplicatedChildEdges(parent, [...existing, ...addChildIds]);
};

/**
 * Recreate the parent/child edges of a duplicated group on its clones. `idMap`
 * maps each source member's id to its clone. Two directions are walked so a
 * cloned child is never left standalone-bookable (the silent gate-drop Fix 2
 * guards against):
 *
 * 1. **Outgoing** — for every cloned parent, the clone requires the **remapped**
 *    child set: an intra-group child points at *its* clone, while a child
 *    **outside** the group keeps referencing the original external listing so the
 *    clone still has a working gate.
 * 2. **Incoming** — for every cloned child whose parent is **outside** the group,
 *    recreate `outsideParent → clonedChild` so the clone stays a child rather
 *    than a standalone bookable listing. (A child whose parent is *inside* the
 *    group is already covered by the outgoing walk.)
 *
 * Each remapped/added set is written through the validated
 * {@link copyDuplicatedChildEdges} path. A no-op when no cloned member touches an
 * edge.
 *
 * Returns the **distinct** edge-copy validation errors collected across both
 * walks (Fix 5): {@link copyDuplicatedChildEdges} returns (rather than throws)
 * when a cloned parent's edge set fails validation, so a clone can be left
 * gateless while the bulk duplicate otherwise succeeds. Surfacing these lets the
 * caller warn the operator instead of silently producing a gateless standalone
 * clone. An empty array means every edge copied cleanly.
 */
export const remapDuplicatedGroupEdges = async (
  idMap: ReadonlyMap<number, number>,
): Promise<string[]> => {
  const errors: string[] = [];
  // Direction 1: outgoing edges of each cloned parent.
  for (const [sourceId, newId] of idMap) {
    const sourceChildIds = await getChildIds(sourceId);
    if (sourceChildIds.length === 0) continue;
    const remapped = sourceChildIds.map(
      (childId) => idMap.get(childId) ?? childId,
    );
    // `newId` is a clone just inserted in this request, so it always loads.
    const newParent = (await getListingWithCount(newId))!;
    const error = await copyDuplicatedChildEdges(newParent, remapped);
    if (error) errors.push(error);
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
      if (!idMap.has(parentId)) outsidePairs.push({ cloneId, parentId });
    }
  }
  const byOutsideParent = Map.groupBy(outsidePairs, (pair) => pair.parentId);
  for (const [parentId, pairs] of byOutsideParent) {
    const error = await addChildrenToParent(
      parentId,
      pairs.map((pair) => pair.cloneId),
    );
    if (error) errors.push(error);
  }
  return unique(errors);
};

/** Handle POST /admin/listing/:id/children (set the required child listings). */
export const handleAdminListingChildren: TypedRouteHandler<
  "POST /admin/listing/:id/children"
> = (request, { id }) =>
  withAuth(request, CONTENT_FORM, (_session, form) =>
    withEntityFromParam(id, getListingWithCount, async (listing) => {
      const result = await validateChildEdges(
        listing,
        form.getNumberArray("child_listing_ids"),
      );
      if (!result.ok) {
        return redirect(`/admin/listing/${id}/edit`, result.error, false);
      }
      const { childIds } = result;
      // A listing that requires children is a parent, which can't be a package
      // member (the package page renders no per-child selectors). Block giving
      // children to a listing already in a package group.
      if (
        childIds.length > 0 &&
        (await anyPackageGroup(await getGroupIdsByListingId(id)))
      ) {
        return redirect(
          `/admin/listing/${id}/edit`,
          t("error.package_incompatible_listing"),
          false,
        );
      }
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
