/**
 * The listing-side bundle checks: the shared listing validator for each
 * planned listing, and the parent-edge rules each named parent must pass.
 */

import { getListingsByGroupIds } from "#db/groups.ts";
import { normalizeEntityName as nameKey } from "#db/name-registry.ts";
import { unique } from "#fp";
import { dayPriceFieldsFromInput } from "#shared/listing-edge.ts";
import { edgeFieldError } from "#shared/listing-parents-rules.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import { packageChildEdgeError } from "#shared/package-membership.ts";
import { requireValue } from "#shared/required-value.ts";
import type { FailureCollector } from "./bundle-names.ts";
import {
  type BundleRef,
  edgeListingOfPlan,
  edgeListingOfRow,
  type ListingPlan,
  type PlannedEdge,
  packageMemberRefusals,
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

/** The plan for every listing item, with the listing validator the form and
 * the single import share. The group-sibling read is hoisted out of the loop,
 * so a 60-listing document stays under the N+1 read guard. */
export const validateListings = async (
  context: ValidationContext,
  pairs: MembershipPairs,
  adminLevel: Parameters<typeof applyImportPolicy>[1],
  fail: FailureCollector,
): Promise<ListingPlan[]> => {
  const siteGroupIds = unique(
    [...context.listingRefs.values()].flatMap((refs) => siteIdsOf(refs.groups)),
  );
  const siblingsByGroup = await getListingsByGroupIds(siteGroupIds);
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
    checkSitePackageJoins(context, pairs, input, item, fail);
  }
  return plans;
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
    const group = context.siteGroupById.get(pair.group.siteId);
    if (group === undefined || !group.is_package) continue;
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
    return (context.groupsByParentId.get(ref.siteId) ?? []).some((groupId) => {
      const group = context.siteGroupById.get(groupId);
      return group?.is_package && group.hide_package_listings;
    });
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

/** One listing item's parent edges: the package conflicts first, as the edge
 * write path orders its guards, then the edge editor's compatibility rules. */
const validateItemEdges = (
  { context, fail, listingPlans, pairs }: EdgeCheckDeps,
  body: ListingBody,
  plan: ListingPlan,
): PlannedEdge[] => {
  const item = body.listing.name;
  const childEdge = edgeListingOfPlan(plan);
  const joinsPackage = joinsAnyPackage(pairs, item, context);
  const edges: PlannedEdge[] = [];
  for (const parentName of body.parents) {
    const resolved = resolvedReference(
      context.listingRefs.get(body)!.parents,
      parentName,
    );
    if (resolved === undefined) continue;
    if (joinsPackage) {
      fail.failItem(item, packageChildEdgeError("child_is_member"));
      break;
    }
    if (parentIsHiddenPackageMember(resolved, pairs, context)) {
      fail.failItem(item, packageChildEdgeError("gate_in_hidden"));
      break;
    }
    const parentEdge =
      "siteId" in resolved
        ? edgeListingOfRow(siteListingOf(resolved, context))
        : edgeListingOfPlan(bundleListingOf(resolved, context, listingPlans));
    fail.failIf(item, edgeFieldError(parentEdge, childEdge));
    if (fail.hasFailed(item)) break;
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
