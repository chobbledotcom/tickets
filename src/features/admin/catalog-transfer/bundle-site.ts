/**
 * The bundle validation context: the document with every reference resolved,
 * the stored rows the site holds, and the membership pairs both sides
 * declared. Every read here is served from the request caches or batched into
 * one query, all before the first database write.
 */

import { listingGroups } from "#db/groups/table.ts";
import { getGroupsById } from "#db/groups.ts";
import { requireListingsWithCountsByIds } from "#db/listings/records.ts";
import {
  type CatalogNameIndex,
  normalizeEntityName as nameKey,
} from "#db/name-registry.ts";
import { unique } from "#fp";
import { requireValue } from "#shared/required-value.ts";
import type { Group, ListingWithCount } from "#types";
import type { FailureCollector, ItemNameIndexes } from "./bundle-names.ts";
import {
  type BundleRef,
  type PlannedMembership,
  type PlannedPair,
  sameMembership,
} from "./bundle-plan.ts";
import {
  firstReferenceError,
  type ListingRefs,
  type Resolved,
  resolvedReference,
  resolveReferences,
  siteIdsOf,
  siteParentIdsOf,
} from "./bundle-refs.ts";
import { membershipSpec } from "./import-listing.ts";
import type {
  CatalogBundle,
  GroupBody,
  GroupMember,
  ListingBody,
  ListingMembership,
} from "./schema.ts";

/** Everything the later phases read: the document and its per-item resolution
 * maps (keyed by the item objects themselves), plus the stored rows the site
 * holds. */
export type ValidationContext = {
  bundle: CatalogBundle;
  groupIndexByName: Map<string, number>;
  groupsByParentId: Map<number, number[]>;
  listingIndexByName: Map<string, number>;
  listingRefs: ReadonlyMap<ListingBody, ListingRefs>;
  memberRefs: ReadonlyMap<GroupBody, ReadonlyMap<string, Resolved>>;
  siteGroupById: Map<number, Group>;
  siteIndex: CatalogNameIndex;
  siteListingById: Map<number, ListingWithCount>;
};

/** The membership pairs both sides declared, indexed by each side's name so
 * the listing-side checks and the group-side checks each find their own. */
export type MembershipPairs = {
  byGroup: Map<string, Map<string, PlannedPair>>;
  byListing: Map<string, Map<string, PlannedPair>>;
};

/** Resolve every reference inside the document first, then against the site,
 * and load the stored rows the checks read. One failed reference per item is
 * attributed to the item that references it. */
export const buildContext = async (
  bundle: CatalogBundle,
  indexes: ItemNameIndexes,
  fail: FailureCollector,
): Promise<ValidationContext> => {
  const { groupIndexByName, listingIndexByName, siteIndex } = indexes;
  const listingRefs = new Map(
    bundle.listings.map((body) => [
      body,
      {
        groups: resolveReferences(
          body.groups.map((entry) => entry.group),
          groupIndexByName,
          siteIndex.group,
          "group",
        ),
        parents: resolveReferences(
          body.parents,
          listingIndexByName,
          siteIndex.listing,
          "listing",
        ),
      },
    ]),
  );
  const memberRefs = new Map(
    bundle.groups.map((body) => [
      body,
      resolveReferences(
        body.members.map((member) => member.listing),
        listingIndexByName,
        siteIndex.listing,
        "listing",
      ),
    ]),
  );
  for (const [body, refs] of listingRefs) {
    fail.failIf(
      body.listing.name,
      firstReferenceError(refs.groups) ?? firstReferenceError(refs.parents),
    );
  }
  for (const [body, refs] of memberRefs) {
    fail.failIf(body.group.name, firstReferenceError(refs));
  }
  const context: ValidationContext = {
    bundle,
    groupIndexByName,
    groupsByParentId: new Map(),
    listingIndexByName,
    listingRefs,
    memberRefs,
    siteGroupById: new Map(),
    siteIndex,
    siteListingById: new Map(),
  };
  const siteListingIds = unique([
    ...siteParentIdsOf(listingRefs),
    ...[...memberRefs.values()].flatMap(siteIdsOf),
  ]);
  context.siteListingById = new Map(
    (await requireListingsWithCountsByIds(siteListingIds)).map((row) => [
      row.id,
      row,
    ]),
  );
  context.siteGroupById = await getGroupsById();
  // Every stored parent's own groups, one batched read, for the
  // hidden-package edge rule.
  const parentIds = unique(siteParentIdsOf(listingRefs));
  context.groupsByParentId =
    parentIds.length === 0
      ? new Map()
      : await listingGroups.getIdsByKeys(parentIds);
  return context;
};

/** The stored listing row behind a site reference. */
export const siteListingOf = (
  ref: BundleRef & { siteId: number },
  context: ValidationContext,
): ListingWithCount =>
  requireValue(
    context.siteListingById.get(ref.siteId),
    "Referenced listing missing",
  );

/** The bundle group a reference resolved to. */
export const bundleGroupOf = (
  ref: BundleRef & { bundleKey: string },
  context: ValidationContext,
): GroupBody =>
  context.bundle.groups[
    requireValue(
      context.groupIndexByName.get(ref.bundleKey),
      "Bundle group missing",
    )
  ]!;

/** The package view of the group a reference resolved to: the stored row's
 * columns or the planned body's fields, projected onto one shape. */
export const groupViewOf = (
  ref: BundleRef,
  context: ValidationContext,
): { isPackage: boolean; hidePackageListings: boolean } => {
  if ("siteId" in ref) {
    const row = requireValue(
      context.siteGroupById.get(ref.siteId),
      "Referenced group missing",
    );
    return {
      hidePackageListings: row.hide_package_listings,
      isPackage: row.is_package,
    };
  }
  const body = bundleGroupOf(ref, context).group;
  return {
    hidePackageListings: body.hidePackageListings ?? false,
    isPackage: body.isPackage ?? false,
  };
};

/** One side's membership declarations, merged into the shared pair indexes. */
const mergePair = (
  pairs: MembershipPairs,
  listingName: string,
  groupName: string,
  listing: BundleRef,
  group: BundleRef,
  spec: PlannedMembership,
  blamedItem: string,
  fail: FailureCollector,
): void => {
  const listingKey = nameKey(listingName);
  const groupKey = nameKey(groupName);
  const existing = pairs.byGroup.get(groupKey)?.get(listingKey);
  const pair = { group, listing, spec };
  if (existing === undefined) {
    const byListingKey = pairs.byGroup.get(groupKey) ?? new Map();
    byListingKey.set(listingKey, pair);
    pairs.byGroup.set(groupKey, byListingKey);
    const byGroupKey = pairs.byListing.get(listingKey) ?? new Map();
    byGroupKey.set(groupKey, pair);
    pairs.byListing.set(listingKey, byGroupKey);
    return;
  }
  const conflict = !sameMembership(existing.spec, spec)
    ? `Listing "${listingName}" and group "${groupName}" are linked twice, with different settings — keep one link.`
    : null;
  fail.failIf(blamedItem, conflict);
};

/** The entries of one list whose named reference resolved, each paired with
 * its resolution. Unresolved names are the item's own reported failure, so
 * the walk skips them. */
const resolvable = <Entry>(
  entries: readonly Entry[],
  refs: ReadonlyMap<string, Resolved>,
  nameOf: (entry: Entry) => string,
): { entry: Entry; resolved: BundleRef }[] =>
  entries.flatMap((entry) => {
    const resolved = resolvedReference(refs, nameOf(entry));
    return resolved === undefined ? [] : [{ entry, resolved }];
  });

/** Collect the membership pairs from both sides, so a listing and a group
 * that declare the same link must agree or the import refuses. The key is the
 * two names — unique across the document and the site together. */
export const collectPairs = (
  context: ValidationContext,
  fail: FailureCollector,
): MembershipPairs => {
  const pairs: MembershipPairs = { byGroup: new Map(), byListing: new Map() };
  for (const body of context.bundle.listings) {
    const refs = context.listingRefs.get(body)!.groups;
    for (const { entry, resolved } of resolvable(
      body.groups,
      refs,
      (membership: ListingMembership) => membership.group,
    )) {
      mergePair(
        pairs,
        body.listing.name,
        entry.group,
        { bundleKey: nameKey(body.listing.name) },
        resolved,
        membershipSpec(entry, groupViewOf(resolved, context).isPackage),
        body.listing.name,
        fail,
      );
    }
  }
  for (const body of context.bundle.groups) {
    const refs = context.memberRefs.get(body)!;
    for (const { entry: member, resolved } of resolvable(
      body.members,
      refs,
      (membership: GroupMember) => membership.listing,
    )) {
      mergePair(
        pairs,
        member.listing,
        body.group.name,
        resolved,
        { bundleKey: nameKey(body.group.name) },
        membershipSpec(member, body.group.isPackage ?? false),
        body.group.name,
        fail,
      );
    }
  }
  return pairs;
};

/** The merged spec of one named pair, which both collection walks wrote. */
export const specOfPair = (
  pairs: MembershipPairs,
  listingName: string,
  groupName: string,
): PlannedMembership =>
  requireValue(
    pairs.byGroup.get(nameKey(groupName))?.get(nameKey(listingName)),
    `Membership pair missing for "${listingName}" in "${groupName}"`,
  ).spec;
