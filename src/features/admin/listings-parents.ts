/**
 * Listing parent/child relationship editing (the "required child listings"
 * section on the listing edit page + its save endpoint).
 */

import { groupToMap, mapNotNullish, unique } from "#fp";
import { t } from "#i18n";
/* jscpd:ignore-start */
import { CONTENT_FORM, formGuard } from "#routes/auth.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
/* jscpd:ignore-end */
import { logActivity } from "#shared/db/activity-log.ts";
import { type TxScope, withTransaction } from "#shared/db/client.ts";
import { listingGroups } from "#shared/db/groups.ts";
import {
  hydrateListingLinks,
  listingChildren,
  listingParents,
  setListingChildrenWithPackageCheckTx,
} from "#shared/db/listing-parents.ts";
import {
  getAllListings,
  getListingsById,
  getListingWithCount,
  requireListingWithCount,
} from "#shared/db/listings/records.ts";
import {
  childOnlyAddOnName,
  childOnlyAddOnNameForListings,
  type ListingGroupMembership,
  toListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
import {
  childAddOnError,
  type EdgeListing,
  edgeFieldError,
  type ParentChildEdge,
} from "#shared/listing-parents-rules.ts";
import {
  type PackageChildEdgeBlock,
  packageChildEdgeError,
  packageChildEdgeErrorOrNull,
} from "#shared/package-membership.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import type { ListingWithCount } from "#shared/types.ts";
import type { ListingParentsSection } from "#templates/admin/listings/types.ts";

/** Error shown when the parent is itself offered as a child: single-level
 * nesting means it can't also gate children. */
const parentIsChildError = (parent: EdgeListing): string =>
  t("listings_table.children_err_parent_is_child", { name: parent.name });

/** Error shown when a chosen child is itself a parent: single-level nesting
 * means it can't also be a child. */
const childIsParentError = (child: EdgeListing): string =>
  t("listings_table.children_err_child_is_parent", { name: child.name });

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
  if (parentIsChild) return parentIsChildError(parent);
  if (candidateIsParent) return childIsParentError(candidate);
  return edgeFieldError(parent, candidate);
};

export const loadListingParentsSection = async (
  listing: ListingWithCount,
): Promise<ListingParentsSection> => {
  const [allListings, childIds, offeredUnderLinks] = await Promise.all([
    getAllListings(),
    listingChildren.getIds(listing.id),
    hydrateListingLinks(listingParents, [listing.id]),
  ]);
  const linkedParents = offeredUnderLinks.listingsByKey.get(listing.id);
  const offeredUnder = linkedParents === undefined ? [] : linkedParents;
  const others = allListings.filter((other) => other.id !== listing.id);
  // Single-level nesting: a listing already offered as a child can't also be a
  // parent, so every candidate is ineligible in that case.
  const parentIsChild = offeredUnder.length > 0;
  // One query for which candidates are themselves parents (so can't be a child),
  // instead of an N+1 over each candidate's children.
  const childrenOf = await listingChildren.getIdsByKeys(
    others.map((other) => other.id),
  );
  const candidates = others.map((candidate) => ({
    ineligibleReason: childEdgeIneligibility(
      listing,
      candidate,
      parentIsChild,
      childrenOf.get(candidate.id)!.length > 0,
    ),
    listing: candidate,
  }));
  return { candidates, childIds: new Set(childIds), offeredUnder };
};

/** Resolve the name of an opt-in add-on that `childId` would orphan from a
 * parent page of `pageIds`, or null. The default resolves add-on scopes from the
 * LIVE listings table (the HTML children form, where the parent row's `group_id`
 * is already persisted); the admin API supplies a would-be variant that resolves
 * against an in-memory listing set carrying the submitted `group_id`. */
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
  if (parentIsChild) return parentIsChildError(parent);
  // The parent's own booking page loads add-ons from ONLY its own listing id
  // (`getTicketContext` → `getOptionalAddOns([parent.id])`), never its group
  // siblings, so reachability is checked against just `[parent.id]`.
  const pageIds = [parent.id];
  for (const { listing, isParent } of children) {
    if (isParent) return childIsParentError(listing);
    const fieldError = edgeFieldError(parent, listing);
    if (fieldError) return fieldError;
    // v1 has no child-scoped add-on render/parse path, so an add-on reachable
    // only through the suppressed child would become a dead end — hard block it.
    // A `bookable_alone` child keeps its OWN booking page, so its add-on is still
    // reachable and the edge must not be blocked (mirrors the modifier/listing
    // save reachability, which count a flagged child among the live pages).
    if (listing.bookable_alone) continue;
    const addOn = await resolveChildOnlyAddOn(listing.id, pageIds);
    if (addOn) return childAddOnError(addOn, listing.name);
  }
  return null;
};

/** The outcome of validating a parent's submitted child ids: either a
 * user-facing error, or the cleaned set of child ids ready to persist. */
export type ChildEdgeValidation =
  | { ok: false; error: string }
  | { ok: true; childIds: number[] };

/**
 * Optional would-be group context for the admin JSON API: the parent's
 * submitted `group_id`, applied to an in-memory listing set so a group-scoped
 * add-on's reachability is resolved against the move the save is about to make
 * (the live `modifier_groups`→`listings` join can't yet see it). Omitted by the
 * HTML children form, whose parent row already carries its live `group_id`.
 */
export type ChildEdgeOptions = { wouldBeGroupIds: number[] };

/** Build the add-on resolver for a child-edge validation: the live-table check
 * for the HTML form, or the in-memory would-be-group check for the admin API
 * mirroring {@link orphanedAddOnAfterChange}'s would-be approach.
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
  const membership = await listingGroups.getIdsByKeys(live.map((l) => l.id));
  const hasParent = live.some((listing) => listing.id === parent.id);
  const base: ListingGroupMembership[] = live.map((listing) => {
    const withGroups = toListingGroupMembership(listing, membership);
    return listing.id === parent.id
      ? { ...withGroups, groupIds: options.wouldBeGroupIds }
      : withGroups;
  });
  // On create the parent row doesn't exist in `live` yet, so append a
  // placeholder carrying its would-be group set.
  const allListings: ListingGroupMembership[] = hasParent
    ? base
    : [...base, { groupIds: options.wouldBeGroupIds, id: parent.id }];
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
 * validate **would-be** edge fields BEFORE the row is written (atomicity): a
 * create has no persisted row yet, and an update's
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
  // change. Dedupe once here so validation and persist agree.
  const childIds = unique(
    submittedChildIds.filter(
      (childId) => childId !== parent.id && byId.has(childId),
    ),
  );
  // Nesting state: whether this listing is already a child (parentIds), and
  // which chosen children are themselves parents (childrenByParent).
  const [parentIds, resolveChildOnlyAddOn, childrenByParent] =
    await Promise.all([
      listingParents.getIds(parent.id),
      childOnlyAddOnResolver(parent, options),
      listingChildren.getIdsByKeys(childIds),
    ]);
  const children = childIds.map((childId) => ({
    isParent: childrenByParent.get(childId)!.length > 0,
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
 * operator — a duplicate that silently drops its required-child gate
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
  try {
    const packageConflict = await withTransaction((tx: TxScope) =>
      setListingChildrenWithPackageCheckTx(tx, newParent.id, result.childIds),
    );
    return packageChildEdgeErrorOrNull(packageConflict);
  } catch (error) {
    // A child can vanish or become a parent after validation but before this
    // transaction. The copy is already committed, so surface the localized
    // validation message through the caller's existing warning flow rather
    // than letting a 500 escape.
    return transactionValidationMessageOrRethrow(error);
  }
};

/** Group parent/child pairs into the child set for each parent. */
const groupChildEdges = (edges: ParentChildEdge[]): Map<number, number[]> =>
  groupToMap(
    (edge: ParentChildEdge) => edge.parentId,
    (edge: ParentChildEdge) => edge.childId,
  )(edges);

const groupRemappedEdges = (
  idMap: ReadonlyMap<number, number>,
  relatedIdsBySource: ReadonlyMap<number, number[]>,
  toEdge: (cloneId: number, relatedId: number) => ParentChildEdge | null,
): Map<number, number[]> =>
  groupChildEdges(
    [...idMap].flatMap(([sourceId, cloneId]) =>
      mapNotNullish((relatedId: number) => toEdge(cloneId, relatedId))(
        relatedIdsBySource.get(sourceId)!,
      ),
    ),
  );

interface GroupEdgePlan {
  existingMode: "keep" | "replace";
  relatedIdsBySource: ReadonlyMap<number, number[]>;
  toEdge: (cloneId: number, relatedId: number) => ParentChildEdge | null;
}

/** Apply each edge plan in order and collect distinct validation errors.
 * Existing children are kept when an outside parent gains cloned children;
 * replacing them would clobber the gate it already had. */
const copyGroupEdgePlans = async (
  idMap: ReadonlyMap<number, number>,
  plans: GroupEdgePlan[],
): Promise<string[]> => {
  const errors: string[] = [];
  for (const plan of plans) {
    const childrenByParent = groupRemappedEdges(
      idMap,
      plan.relatedIdsBySource,
      plan.toEdge,
    );
    for (const [parentId, childIds] of childrenByParent) {
      const parent = await requireListingWithCount(parentId);
      const existing =
        plan.existingMode === "keep"
          ? await listingChildren.getIds(parentId)
          : [];
      const error = await copyDuplicatedChildEdges(parent, [
        ...existing,
        ...childIds,
      ]);
      if (error) errors.push(error);
    }
  }
  return unique(errors);
};

/**
 * Recreate the parent/child edges of a duplicated group on its clones. `idMap`
 * maps each source member's id to its clone. Two directions are walked so a
 * cloned child is never left standalone-bookable (the silent gate-drop this
 * guards against):
 *
 * 1. Outgoing — each cloned parent requires the remapped child set: an
 *    intra-group child points at its clone, while a child outside the group
 *    keeps referencing the original, so the clone still has a working gate.
 * 2. Incoming — for a cloned child whose parent sits outside the group,
 *    recreate `outsideParent → clonedChild` so the clone stays a child rather
 *    than standalone. A parent inside the group is already covered above.
 *
 * Each set is written through the validated {@link copyDuplicatedChildEdges},
 * which returns rather than throws when validation fails, so a clone can be
 * left gateless while the bulk duplicate otherwise succeeds. The distinct
 * errors from both walks are returned so the caller can warn the operator
 * instead of silently producing a gateless standalone clone; an empty array
 * means every edge copied cleanly.
 */
export const remapDuplicatedGroupEdges = async (
  idMap: ReadonlyMap<number, number>,
): Promise<string[]> => {
  const sourceIds = [...idMap.keys()];
  const [childrenByParent, parentsByChild] = await Promise.all([
    listingChildren.getIdsByKeys(sourceIds),
    listingParents.getIdsByKeys(sourceIds),
  ]);
  return copyGroupEdgePlans(idMap, [
    {
      existingMode: "replace",
      relatedIdsBySource: childrenByParent,
      toEdge: (cloneId, childId) => {
        const clonedChildId = idMap.get(childId);
        return {
          childId: clonedChildId === undefined ? childId : clonedChildId,
          parentId: cloneId,
        };
      },
    },
    {
      existingMode: "keep",
      relatedIdsBySource: parentsByChild,
      toEdge: (cloneId, parentId) =>
        idMap.has(parentId) ? null : { childId: cloneId, parentId },
    },
  ]);
};

/** Handle POST /admin/listing/:id/children (set the required child listings). */
const listingChildrenHandler = createIdEntityHandler<ListingWithCount>(
  getListingWithCount,
)(formGuard(CONTENT_FORM));

export const handleAdminListingChildren: TypedRouteHandler<"POST /admin/listing/:id/children"> =
  listingChildrenHandler(async (listing, _session, form, _request, { id }) => {
    const result = await validateChildEdges(
      listing,
      form.getNumberArray("child_listing_ids"),
    );
    if (!result.ok) {
      return redirect(`/admin/listing/${id}/edit`, result.error, false);
    }
    const { childIds } = result;
    let packageConflict: PackageChildEdgeBlock | null;
    try {
      packageConflict = await withTransaction((tx: TxScope) =>
        setListingChildrenWithPackageCheckTx(tx, id, childIds),
      );
    } catch (error) {
      return redirect(
        "/admin/listings",
        transactionValidationMessageOrRethrow(error),
        false,
      );
    }
    if (packageConflict) {
      return redirect(
        `/admin/listing/${id}/edit`,
        packageChildEdgeError(packageConflict),
        false,
      );
    }
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
  });
