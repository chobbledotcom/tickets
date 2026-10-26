/**
 * The listing-side bundle checks: the shared listing validator for each
 * planned listing, and the parent-edge rules each named parent must pass.
 */

/* jscpd:ignore-start -- imports */
import { getListingsByGroupIds } from "#db/groups.ts";
import { normalizeEntityName as nameKey } from "#db/name-registry.ts";
import { requiredMapValue, unique } from "#fp";
import { t } from "#i18n";
import { dayPriceFieldsFromInput } from "#shared/listing-edge.ts";
import {
  childAddOnError,
  edgeFieldError,
} from "#shared/listing-parents-rules.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import {
  packageChildEdgeError,
  sitePlanMemberError,
} from "#shared/package-membership.ts";
import { requireValue } from "#shared/required-value.ts";
import type { ListingWithCount } from "#types";
import type { FailureCollector } from "./bundle-names.ts";
import {
  type BundleRef,
  edgeListingOfPlan,
  edgeListingOfRow,
  type ListingPlan,
  type PlannedEdge,
  packageMemberRefusals,
  siteGroupIdsOfPairs,
} from "./bundle-plan.ts";
import { resolvedReference, siteIdsOf } from "./bundle-refs.ts";
import {
  groupViewOf,
  type MembershipPairs,
  siteListingOf,
  type ValidationContext,
} from "./bundle-site.ts";
import { applyImportPolicy, listingDataToInput } from "./import-listing.ts";
import type { ListingBody } from "./schema.ts";
/* jscpd:ignore-end */

/** The plan for every listing item, with the listing validator the form and
 * the single import share. The group-sibling read is hoisted out of the loop,
 * so a 60-listing document stays under the N+1 read guard. */
export const validateListings = async (
  context: ValidationContext,
  pairs: MembershipPairs,
  adminLevel: Parameters<typeof applyImportPolicy>[1],
  fail: FailureCollector,
): Promise<ListingPlan[]> => {
  const siblingsByGroup = await getListingsByGroupIds(context.siteGroupIds);
  const plans: ListingPlan[] = [];
  for (const [body, refs] of context.listingRefs) {
    const item = body.listing.name;
    const input = applyImportPolicy(
      listingDataToInput(body.listing, "", "", siteIdsOf(refs.groups)),
      adminLevel,
    );
    plans.push({ input, parentKeys: body.parents.map(nameKey) });
    if (fail.hasFailed(item)) continue;
    fail.failIf(
      item,
      await validateListingInput(input, undefined, { siblingsByGroup }),
    );
    // A group that holds a stored built-site plan can only lose members.
    // The single import refuses this join inside its write transaction.
    fail.failIf(
      item,
      storedPlanJoinError(siteIdsOf(refs.groups), siblingsByGroup),
    );
    checkSitePackageJoins(context, pairs, input, item, fail);
  }
  return plans;
};

/** The refusal for a join into a site group that holds a stored built-site
 * plan. The plan books its own site, so the group can only lose members. */
const storedPlanJoinError = (
  groupIds: readonly number[],
  siblingsByGroup: ReadonlyMap<number, ListingWithCount[]>,
): string | null => {
  for (const groupId of groupIds) {
    const plan = requiredMapValue(
      siblingsByGroup,
      groupId,
      "Missing group listing membership",
    ).find((listing) => listing.assign_built_site);
    if (plan !== undefined) return sitePlanMemberError(plan.name);
  }
  return null;
};

/** The listing-side package checks for SITE package groups: the pick count
 * and the day-price overrides, judged against the planned listing's own
 * fields. A bundle package group judges its members on the group side. */
const checkSitePackageJoins = (
  context: ValidationContext,
  pairs: MembershipPairs,
  input: ListingPlan["input"],
  item: string,
  fail: FailureCollector,
): void => {
  for (const pair of pairs.byListing.get(nameKey(item))?.values() ?? []) {
    if (!("siteId" in pair.group)) continue;
    // The group a resolved reference names was loaded with the context, so
    // the row is present.
    const group = requireValue(
      context.siteGroupById.get(pair.group.siteId),
      "Referenced group missing",
    );
    if (!group.is_package) continue;
    const refusals = packageMemberRefusals(
      item,
      {
        max_quantity: input.maxQuantity ?? 1,
        min_quantity: input.minQuantity ?? 1,
      },
      pair.spec,
      dayPriceFieldsFromInput(input),
    );
    for (const refusal of refusals) fail.failItem(item, refusal);
  }
};

/** The planned listing a bundle reference resolved to. */
export const bundleListingOf = (
  ref: BundleRef & { bundleKey: string },
  context: ValidationContext,
  listingPlans: readonly ListingPlan[],
): ListingPlan =>
  listingPlans[
    requireValue(
      context.listingIndexByName.get(ref.bundleKey),
      "Bundle listing missing",
    )
  ]!;

/** Whether any group the listing joins satisfies `ok`. The pairs hold every
 * membership declaration the document merges, so both package scans read the
 * same source. */
const joinsGroupWhere = (
  pairs: MembershipPairs,
  listingKey: string,
  _context: ValidationContext,
  ok: (group: BundleRef) => boolean,
): boolean => {
  for (const pair of pairs.byListing.get(listingKey)?.values() ?? []) {
    if (ok(pair.group)) return true;
  }
  return false;
};

/** Whether the listing a reference resolved to sits in a package that hides
 * its member names. This is the parent-side edge block. A stored parent reads
 * the stored memberships. A planned parent reads the document's own merged
 * membership pairs. */
export const parentIsHiddenPackageMember = (
  ref: BundleRef,
  pairs: MembershipPairs,
  context: ValidationContext,
): boolean => {
  if ("siteId" in ref) {
    // Every stored parent the document names was loaded into the map, so an
    // absent key is a vanished row.
    const groupIds = requireValue(
      context.groupsByParentId.get(ref.siteId),
      "Parent groups missing",
    );
    for (const groupId of groupIds) {
      const group = requireValue(
        context.siteGroupById.get(groupId),
        "Referenced group missing",
      );
      if (group.is_package && group.hide_package_listings) return true;
    }
    return false;
  }
  return joinsGroupWhere(pairs, ref.bundleKey, context, (group) => {
    const { hidePackageListings, isPackage } = groupViewOf(group, context);
    return isPackage && hidePackageListings;
  });
};

/** Whether any group the listing joins is a package. */
const joinsAnyPackage = (
  pairs: MembershipPairs,
  listingName: string,
  context: ValidationContext,
): boolean =>
  joinsGroupWhere(
    pairs,
    nameKey(listingName),
    context,
    (group) => groupViewOf(group, context).isPackage,
  );

/** The helpers one listing item's edge check reads. */
type EdgeCheckDeps = {
  context: ValidationContext;
  fail: FailureCollector;
  listingPlans: readonly ListingPlan[];
  pairs: MembershipPairs;
};

/** True when the named parent is a child, or the document makes it one.
 * A stored parent can sit under its own parent. A planned item can declare
 * parents of its own. The edge write refuses both nests. */
const parentIsAChild = (
  resolved: BundleRef,
  { context, listingPlans }: EdgeCheckDeps,
): boolean => {
  if ("siteId" in resolved) {
    return context.siteListingsWithParent.has(resolved.siteId);
  }
  return bundleListingOf(resolved, context, listingPlans).parentKeys.length > 0;
};

/** The site groups the merged membership pairs give one listing. Both
 * declaration sides land in the pairs, so this is the membership set the
 * write creates. */
const siteGroupIdsOfListing = (
  pairs: MembershipPairs,
  listingKey: string,
): number[] =>
  siteGroupIdsOfPairs(pairs.byListing.get(listingKey)?.values() ?? []);

/** Whether one opt-in add-on reaches the edge's parent, through the
 * parent's groups. A site row reads its stored groups. A planned item reads
 * the document's merged memberships. */
const addOnReachesParent = (
  { context, pairs }: EdgeCheckDeps,
  addOnId: number,
  parent: BundleRef,
): boolean => {
  let parentGroupIds: readonly number[] = [];
  if ("siteId" in parent) {
    parentGroupIds = requireValue(
      context.groupsByParentId.get(parent.siteId),
      "Parent groups missing",
    );
  } else {
    parentGroupIds = unique(siteGroupIdsOfListing(pairs, parent.bundleKey));
  }
  for (const groupId of parentGroupIds) {
    const addOns = requireValue(
      context.optInAddOnsByGroup.get(groupId),
      "Group add-ons missing",
    );
    for (const addOn of addOns) {
      if (addOn.id === addOnId) return true;
    }
  }
  return false;
};

/** The add-on dead-end refusal for one child-parent edge, or null. A
 * group-scoped opt-in add-on the child reaches must also reach the parent.
 * The child's own booking page exempts it. The edge write checks the same
 * reachability inside its transaction. */
const childAddOnDeadEndError = (
  deps: EdgeCheckDeps,
  plan: ListingPlan,
  childKey: string,
  parent: BundleRef,
): string | null => {
  if (plan.input.bookableAlone ?? false) return null;
  const groupIds = unique(siteGroupIdsOfListing(deps.pairs, childKey));
  const judged = new Map<number, string>();
  for (const groupId of groupIds) {
    const addOns = requireValue(
      deps.context.optInAddOnsByGroup.get(groupId),
      "Group add-ons missing",
    );
    for (const addOn of addOns) {
      judged.set(addOn.id, addOn.name);
    }
  }
  for (const [addOnId, addOnName] of judged) {
    const reaches = addOnReachesParent(deps, addOnId, parent);
    if (!reaches) return childAddOnError(addOnName, plan.input.name);
  }
  return null;
};

/** The refusal for one declared edge, or null when the edge can be written.
 * The checks follow the edge write's guard order: the nesting rule, then the
 * package conflicts, then the field rules, then the child add-on's reach. */
const edgeRefusal = (
  deps: EdgeCheckDeps,
  body: ListingBody,
  plan: ListingPlan,
  resolved: BundleRef,
): string | null => {
  const { context, listingPlans, pairs } = deps;
  if (parentIsAChild(resolved, deps)) {
    return t("error.parent_is_already_a_child");
  }
  if (parentIsHiddenPackageMember(resolved, pairs, context)) {
    return packageChildEdgeError("gate_in_hidden");
  }
  if (joinsAnyPackage(pairs, body.listing.name, context)) {
    return packageChildEdgeError("child_is_member");
  }
  const parentEdge =
    "siteId" in resolved
      ? edgeListingOfRow(siteListingOf(resolved, context))
      : edgeListingOfPlan(bundleListingOf(resolved, context, listingPlans));
  const fieldError = edgeFieldError(parentEdge, edgeListingOfPlan(plan));
  if (fieldError !== null) return fieldError;
  return childAddOnDeadEndError(
    deps,
    plan,
    nameKey(body.listing.name),
    resolved,
  );
};

/** One listing item's parent edges: each edge runs the checks the edge write
 * guards, in its order. The first refusal fails the item and stops it. */
const validateItemEdges = (
  { context, fail, listingPlans, pairs }: EdgeCheckDeps,
  body: ListingBody,
  plan: ListingPlan,
): PlannedEdge[] => {
  const deps = { context, fail, listingPlans, pairs };
  const item = body.listing.name;
  const edges: PlannedEdge[] = [];
  for (const parentName of body.parents) {
    const resolved = resolvedReference(
      context.listingRefs.get(body)!.parents,
      parentName,
    );
    if (resolved === undefined) continue;
    const refusal = edgeRefusal(deps, body, plan, resolved);
    if (refusal !== null) {
      fail.failItem(item, refusal);
      break;
    }
    edges.push({ child: { bundleKey: nameKey(item) }, parent: resolved });
  }
  return edges;
};

/** The parent edges of every listing item, each one validated. */
export const validateEdges = (
  context: ValidationContext,
  listingPlans: readonly ListingPlan[],
  pairs: MembershipPairs,
  fail: FailureCollector,
): PlannedEdge[] => {
  const edges: PlannedEdge[] = [];
  const deps = { context, fail, listingPlans, pairs };
  for (const [index, body] of context.bundle.listings.entries()) {
    if (body.parents.length > 0) {
      edges.push(...validateItemEdges(deps, body, listingPlans[index]!));
    }
  }
  return edges;
};
