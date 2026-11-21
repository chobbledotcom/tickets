/**
 * The bundle validation context: the document with every reference resolved,
 * the stored rows the site holds, and the membership pairs both sides
 * declared. Every read here is served from the request caches or batched into
 * one query, all before the first database write.
 */

import { listingGroups } from "#db/groups/table.ts";
import { getGroupsById } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { requireListingsWithCountsByIds } from "#db/listings/records.ts";
import { readRows } from "#db/read.ts";
import { among, equal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { unique } from "#fp";
import { matchKey as nameKey } from "#shared/keys.ts";
import { requiredMapValueWithMessage } from "#shared/required-map-value.ts";
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
  refsOf,
  resolvedReference,
  resolveReferences,
  siteIdsOf,
  siteParentIdsOf,
} from "./bundle-refs.ts";
import { type MembershipOverrides, membershipSpec } from "./import-listing.ts";
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
  optInAddOnsByGroup: ReadonlyMap<number, GroupOptIns>;
  siteGroupById: Map<number, Group>;
  /** The site groups the document's listings join. */
  siteGroupIds: readonly number[];
  siteListingById: Map<number, ListingWithCount>;
  /** The site listings that sit under a parent of their own. */
  siteListingsWithParent: ReadonlySet<number>;
};

/** One group-scoped opt-in add-on: its modifier id for the dedup and its
 * decrypted name for the refusal message. */
export type OptInAddOn = { id: number; name: string };

/** What one site group carries in opt-in add-ons. `addOnIds` mirrors
 * `addOns` for the membership probe. */
export type GroupOptIns = { addOnIds: Set<number>; addOns: OptInAddOn[] };

/** The opt-in add-ons one group carries. The loader gives every requested
 * group an entry, so a missing entry means a broken read. */
export const groupOptIns = (
  addOnsByGroup: ReadonlyMap<number, GroupOptIns>,
  groupId: number,
): GroupOptIns =>
  requiredMapValueWithMessage(addOnsByGroup, groupId, "Group add-ons missing");

/** The group-scoped opt-in add-ons covering `groupIds`, one query, names
 * decrypted for the refusal message. These are the only opt-ins that can
 * reach a planned listing. A planned listing carries no add-on links of its
 * own, so only a group it joins reaches one. */
const optInAddOnsByGroupId = async (
  groupIds: readonly number[],
): Promise<ValidationContext["optInAddOnsByGroup"]> => {
  const byGroup = new Map<number, GroupOptIns>();
  if (groupIds.length === 0) return byGroup;
  // Every requested group gets an entry, so the checks read one without a
  // fallback.
  for (const groupId of groupIds) {
    byGroup.set(groupId, { addOnIds: new Set(), addOns: [] });
  }
  const rows = await readRows(
    from(tables.modifier_groups, { modifier: {} })
      .where((link) => [
        equal(link.modifier.active, 1),
        equal(link.modifier.trigger, "optional"),
        equal(link.modifier.scope, "groups"),
        among(link.groupId, groupIds),
      ])
      .select((link) => ({
        groupId: link.groupId,
        modifierId: link.modifier.id,
        name: link.modifier.name,
      })),
  );
  for (const row of rows) {
    const optIns = groupOptIns(byGroup, row.groupId);
    optIns.addOns.push({ id: row.modifierId, name: row.name });
    optIns.addOnIds.add(row.modifierId);
  }
  return byGroup;
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
      // The single import resolves a listing's parents before its groups, so
      // the shared phase reports in that order too.
      firstReferenceError(refs.parents) ?? firstReferenceError(refs.groups),
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
    optInAddOnsByGroup: new Map(),
    siteGroupById: new Map(),
    siteGroupIds: [],
    siteListingById: new Map(),
    siteListingsWithParent: new Set(),
  };
  const siteGroupIds = unique(
    [...listingRefs.values()].flatMap((refs) => siteIdsOf(refs.groups)),
  );
  const parentIds = unique(siteParentIdsOf(listingRefs));
  const siteListingIds = unique([
    ...parentIds,
    ...[...memberRefs.values()].flatMap(siteIdsOf),
  ]);
  context.siteListingById = new Map(
    (await requireListingsWithCountsByIds(siteListingIds)).map((row) => [
      row.id,
      row,
    ]),
  );
  context.siteGroupById = await getGroupsById();
  context.siteGroupIds = siteGroupIds;
  // Every stored parent's own groups, one batched read, for the
  // hidden-package edge rule.
  context.groupsByParentId =
    parentIds.length === 0
      ? new Map()
      : await listingGroups.getIdsByKeys(parentIds);
  // The site listings that sit under a parent of their own: the nesting rule
  // the edge write applies to every named parent.
  const parentLinks = await listingParents.getIdsByKeys(parentIds);
  context.siteListingsWithParent = new Set(
    [...parentLinks].flatMap(([id, links]) => (links.length > 0 ? [id] : [])),
  );
  context.optInAddOnsByGroup = await optInAddOnsByGroupId(siteGroupIds);
  return context;
};

/** The stored listing row behind a site reference. */
export const siteListingOf = (
  ref: BundleRef & { siteId: number },
  context: ValidationContext,
): ListingWithCount =>
  requiredMapValueWithMessage(
    context.siteListingById,
    ref.siteId,
    "Referenced listing missing",
  );

/** The bundle group a reference resolved to. */
export const bundleGroupOf = (
  ref: BundleRef & { bundleKey: string },
  context: ValidationContext,
): GroupBody =>
  context.bundle.groups[
    requiredMapValueWithMessage(
      context.groupIndexByName,
      ref.bundleKey,
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
    const row = requiredMapValueWithMessage(
      context.siteGroupById,
      ref.siteId,
      "Referenced group missing",
    );
    return {
      hidePackageListings: row.hidePackageListings,
      isPackage: row.isPackage,
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

/** One membership that either side of the document declared. */
type DeclaredPair = {
  entry: MembershipOverrides;
  group: string;
  groupRef: BundleRef;
  isPackage: boolean;
  /** The item that declared the link. A refusal names it. */
  item: string;
  listing: string;
  listingRef: BundleRef;
};

/** Merge one declared membership into the pair indexes, or record the
 * refusal for its overrides on the item that declared it. */
const mergeDeclaredPair = (
  pairs: MembershipPairs,
  fail: FailureCollector,
  declared: DeclaredPair,
): void => {
  const spec = membershipSpec(declared.entry, declared.isPackage);
  if (!spec.ok) {
    fail.failItem(declared.item, spec.error);
    return;
  }
  mergePair(
    pairs,
    declared.listing,
    declared.group,
    declared.listingRef,
    declared.groupRef,
    spec.value,
    declared.item,
    fail,
  );
};

/** Collect the membership pairs from both sides, so a listing and a group
 * that declare the same link must agree or the import refuses. The key is the
 * two names — unique across the document and the site together. */
export const collectPairs = (
  context: ValidationContext,
  fail: FailureCollector,
): MembershipPairs => {
  const pairs: MembershipPairs = { byGroup: new Map(), byListing: new Map() };
  for (const body of context.bundle.listings) {
    const refs = refsOf(
      context.listingRefs,
      body,
      `Listing ${body.listing.name}`,
    ).groups;
    for (const { entry, resolved } of resolvable(
      body.groups,
      refs,
      (membership: ListingMembership) => membership.group,
    )) {
      mergeDeclaredPair(pairs, fail, {
        entry: {
          dayPrices: entry.dayPrices,
          packagePrice: entry.packagePrice,
          quantity: entry.quantity,
        },
        group: entry.group,
        groupRef: resolved,
        isPackage: groupViewOf(resolved, context).isPackage,
        item: body.listing.name,
        listing: body.listing.name,
        listingRef: { bundleKey: nameKey(body.listing.name) },
      });
    }
  }
  for (const body of context.bundle.groups) {
    const refs = refsOf(context.memberRefs, body, `Group ${body.group.name}`);
    for (const { entry: member, resolved } of resolvable(
      body.members,
      refs,
      (membership: GroupMember) => membership.listing,
    )) {
      mergeDeclaredPair(pairs, fail, {
        entry: {
          dayPrices: member.dayPrices,
          packagePrice: member.packagePrice,
          quantity: member.quantity,
        },
        group: body.group.name,
        groupRef: { bundleKey: nameKey(body.group.name) },
        isPackage: body.group.isPackage ?? false,
        item: body.group.name,
        listing: member.listing,
        listingRef: resolved,
      });
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
