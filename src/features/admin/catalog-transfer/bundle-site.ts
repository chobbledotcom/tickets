/**
 * The bundle validation context: the document with every reference resolved,
 * the stored rows the site holds, and the membership pairs both sides
 * declared. Every read here is served from the request caches or batched into
 * one query, all before the first database write.
 */

import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
/* jscpd:ignore-start -- imports */
import { inPlaceholders, queryAll } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getGroupsById } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import { requireListingsWithCountsByIds } from "#db/listings/records.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { normalizeEntityName as nameKey } from "#db/name-registry.ts";
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
/* jscpd:ignore-end */

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
  optInAddOnsByGroup: ReadonlyMap<number, OptInAddOn[]>;
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

/** The opt-in add-ons one group carries. The loader gives every requested
 * group an entry, so a missing entry means a broken read. */
export const optInAddOnsOnGroup = (
  addOnsByGroup: ReadonlyMap<number, OptInAddOn[]>,
  groupId: number,
): OptInAddOn[] =>
  requireValue(addOnsByGroup.get(groupId), "Group add-ons missing");

/** The group-scoped opt-in add-ons covering `groupIds`, one query, names
 * decrypted for the refusal message. These are the only opt-ins that can
 * reach a planned listing. A planned listing carries no add-on links of its
 * own, so only a group it joins reaches one. */
const optInAddOnsByGroupId = async (
  groupIds: readonly number[],
): Promise<ValidationContext["optInAddOnsByGroup"]> => {
  const byGroup = new Map<number, { id: number; name: string }[]>();
  if (groupIds.length === 0) return byGroup;
  // Every requested group gets an entry, so the checks read one without a
  // fallback.
  for (const groupId of groupIds) byGroup.set(groupId, []);
  const rows = await queryAll<{
    group_id: number;
    modifier_id: number;
    name: EnvKeyEncrypted;
  }>(
    `SELECT modifierGroup.group_id, modifier.id AS modifier_id, modifier.name
       FROM modifiers AS modifier
       JOIN modifier_groups AS modifierGroup
         ON modifierGroup.modifier_id = modifier.id
      WHERE modifier.active = 1 AND modifier.trigger = 'optional'
        AND modifier.scope = 'groups'
        AND modifierGroup.group_id IN (${inPlaceholders(groupIds)})`,
    [...groupIds],
  );
  for (const row of rows) {
    const addOns = optInAddOnsOnGroup(byGroup, row.group_id);
    addOns.push({
      id: row.modifier_id,
      name: await modifiersTable.readColumn("name", row.name, row.modifier_id),
    });
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
        membershipSpec(
          entry.packagePrice,
          entry.quantity,
          entry.dayPrices,
          groupViewOf(resolved, context).isPackage,
        ),
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
        membershipSpec(
          member.packagePrice,
          member.quantity,
          member.dayPrices,
          body.group.isPackage ?? false,
        ),
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
