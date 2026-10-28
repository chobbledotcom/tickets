/** Loads public group members and decides which group booking links work. */

import { buildBookingTree } from "#booking/build-tree.ts";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import {
  packageBundleLimit,
  packageLimitInfo,
  treePackageBundleMinimum,
} from "#booking/package-cap.ts";
import {
  getDatelessGroupRemaining,
  remainingByListingOverGroups,
} from "#db/attendees/capacity/groups.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  getGroupPackagePricesByGroupIds,
  getListingsByGroupIds,
  groups,
  packageMemberMaps,
} from "#db/groups.ts";
import { hydrateListingLinks, listingChildren } from "#db/listing-parents.ts";
/* jscpd:ignore-start */
import { requiredMapValue, uniqueBy } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import type { Group, GroupWithMembers, ListingWithCount } from "#types";
import { mappedChildrenByParentId } from "./child-listings.ts";
import { classifyForDiscovery } from "./discovery.ts";

/* jscpd:ignore-end */

type MembersByGroup = ReadonlyMap<number, readonly ListingWithCount[]>;

type PublicGroupSummary = Pick<Group, "description" | "name" | "slug">;

export const publicGroupSummary = ({
  group,
}: GroupWithMembers): PublicGroupSummary => ({
  description: group.description,
  name: group.name,
  slug: group.slug,
});

type LoadGroupMembers = (
  groupList: readonly Group[],
) => Promise<Map<number, ListingWithCount[]>>;

const membersOf = (
  group: Group,
  membersByGroup: MembersByGroup,
): readonly ListingWithCount[] =>
  requiredMapValue(
    membersByGroup,
    group.id,
    `Members missing for group ${group.id}`,
  );

const activeMembersByGroup: LoadGroupMembers = (groupList) =>
  getListingsByGroupIds(
    groupList.map((group) => group.id),
    true,
  );

/** Whether `member` appears on this group's public booking page. A package is
 * one product built from every member, so a hidden member stays in the bundle.
 * A regular group offers a hidden member only when it ticked the group's
 * "Show hidden listings" box. */
const buyerSeesMember = (group: Group, member: ListingWithCount): boolean =>
  group.is_package || group.show_hidden_listings || !member.hidden;

/** Each group's active members as its public booking page shows them. */
const publicMembersByGroup: LoadGroupMembers = async (groupList) => {
  const membersByGroup = await activeMembersByGroup(groupList);
  return new Map(
    groupList.map((group) => [
      group.id,
      membersOf(group, membersByGroup).filter((member) =>
        buyerSeesMember(group, member),
      ),
    ]),
  );
};

const groupKinds = (
  groupList: readonly Group[],
): { packages: Group[]; regular: Group[] } => ({
  packages: groupList.filter((group) => group.is_package),
  regular: groupList.filter((group) => !group.is_package),
});

const uniqueMembersFor = (
  groupList: readonly Group[],
  membersByGroup: MembersByGroup,
): ListingWithCount[] =>
  uniqueBy((member: ListingWithCount) => member.id)(
    groupList.flatMap((group) => membersOf(group, membersByGroup)),
  );

/** Buyer-visible active members of several groups, loaded in a bounded number
 * of reads rather than one query per group. */
export const getVisibleGroupMembersByGroupIds: LoadGroupMembers =
  publicMembersByGroup;

/** Load one group's buyer-visible active members through the batch path. */
export const getVisibleGroupMembers = async (
  group: Group,
): Promise<ListingWithCount[]> =>
  membersOf(group, await getVisibleGroupMembersByGroupIds([group])).slice();

const NO_BLOCKED_MEMBERS: ReadonlySet<number> = new Set();

/** Shows every complete package whose whole bundle still fits. Member prices,
 * children, memberships, and capacity load once for the full package set. Each
 * package then runs the same booking-tree limit over its own members. */
const bookablePackageIds = async (
  packages: readonly Group[],
  membersByGroup: MembersByGroup,
): Promise<number[]> => {
  if (packages.length === 0) return [];
  const packageMembers = uniqueMembersFor(packages, membersByGroup);
  const [rowsByGroup, childLinks] = await Promise.all([
    getGroupPackagePricesByGroupIds(packages.map((group) => group.id)),
    hydrateListingLinks(
      listingChildren,
      packageMembers.map((member) => member.id),
    ),
  ]);
  const childrenByParent = childLinks.listingsByKey;
  const limitListings = uniqueBy((listing: ListingWithCount) => listing.id)([
    ...packageMembers,
    ...[...childrenByParent.values()].flat(),
  ]);
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    limitListings.map((listing) => listing.id),
  );
  const remaining = await getDatelessGroupRemaining(
    limitListings,
    groupIdsByListingId,
  );
  const remainingByListingId = remainingByListingOverGroups(
    limitListings.map((listing) => listing.id),
    groupIdsByListingId,
    remaining,
  );
  const toTicketListing = (listing: ListingWithCount): TicketListing =>
    buildTicketListing(
      listing,
      isRegistrationClosed(listing),
      remainingByListingId.get(listing.id),
    );
  const childrenByParentId = mappedChildrenByParentId(
    childrenByParent,
    (_parentId, child) => toTicketListing(child),
  );
  return packages
    .filter((group) => {
      const members = membersOf(group, membersByGroup);
      if (members.length === 0) return false;
      const rows = requiredMapValue(
        rowsByGroup,
        group.id,
        `Package members missing for group ${group.id}`,
      );
      if (members.length < rows.length) return false;
      const ticketListings = members.map(toTicketListing);
      const maps = packageMemberMaps(rows);
      const tree = buildBookingTree({
        childrenByParentId,
        listings: ticketListings,
        packages: [
          {
            dayPrices: new Map(),
            groupId: group.id,
            hideListings: group.hide_package_listings,
            memberListingIds: members.map((member) => member.id),
            prices: maps.prices,
            quantities: maps.quantities,
          },
        ],
        slugs: members.map((member) => member.slug),
      });
      return (
        treePackageBundleMinimum(tree, ticketListings) <=
        packageBundleLimit(
          tree,
          packageLimitInfo(
            ticketListings,
            childrenByParentId,
            remaining,
            groupIdsByListingId,
          ),
        )
      );
    })
    .map((group) => group.id);
};

/** Decide several groups from one shared member load and one classification of
 * all regular members. Package-specific trees share their database facts.
 * `blockSoldOutParents` picks the regular member rule. Bookability blocks the
 * parents projected sold out, because a booking needs a member to start from.
 * A page render keeps them, sold out. */
const decideGroupIds = async (
  groupList: readonly Group[],
  membersByGroup: MembersByGroup,
  blockSoldOutParents: boolean,
): Promise<ReadonlySet<number>> => {
  const { packages, regular } = groupKinds(groupList);
  const regularMembers = uniqueMembersFor(regular, membersByGroup);
  const [classification, packageIds] = await Promise.all([
    regularMembers.length > 0
      ? classifyForDiscovery(regularMembers)
      : Promise.resolve(null),
    bookablePackageIds(packages, membersByGroup),
  ]);
  if (classification === null) return new Set(packageIds);
  const blockedIds = blockSoldOutParents
    ? classification.soldOutParentIds
    : NO_BLOCKED_MEMBERS;
  const regularIds = regular
    .filter((group) =>
      membersOf(group, membersByGroup).some(
        (member) =>
          !classification.childIds.has(member.id) && !blockedIds.has(member.id),
      ),
    )
    .map((group) => group.id);
  return new Set([...regularIds, ...packageIds]);
};

/** Whether one group's public booking page can accept a booking. */
export const groupBookable = async (
  group: Group,
  members: readonly ListingWithCount[],
): Promise<boolean> =>
  (await decideGroupIds([group], new Map([[group.id, members]]), true)).has(
    group.id,
  );

/** The ids of non-hidden groups whose Book link leads to a bookable page, from
 *  one buyer-visible member read. */
export const loadBookableGroupIds = async (
  groupList: readonly Group[],
): Promise<ReadonlySet<number>> => {
  const membersByGroup = await publicMembersByGroup(groupList);
  return decideGroupIds(groupList, membersByGroup, true);
};

/** Load non-hidden groups one member rule keeps: one buyer-visible member
 *  read backs the decision and the returned members. */
const loadDecidedGroups = async (
  blockSoldOutParents: boolean,
): Promise<GroupWithMembers[]> => {
  const visibleGroups = (await groups.cache.getAll()).filter(
    (group) => !group.hidden,
  );
  const membersByGroup = await publicMembersByGroup(visibleGroups);
  const ids = await decideGroupIds(
    visibleGroups,
    membersByGroup,
    blockSoldOutParents,
  );
  return visibleGroups
    .filter((group) => ids.has(group.id))
    .map((group) => ({
      group,
      members: membersOf(group, membersByGroup).slice(),
    }));
};

/** Load non-hidden groups whose Book link leads to a bookable page. */
export const loadPublicGroups = (): Promise<GroupWithMembers[]> =>
  loadDecidedGroups(true);

/** Load non-hidden groups whose /ticket page serves. A package keeps its
 *  bookable-bundle gate. A regular group keeps one visible active non-child
 *  member even when every parent is projected sold out. */
export const loadServedGroups = (): Promise<GroupWithMembers[]> =>
  loadDecidedGroups(false);

/** Packages a public surface can advertise as first-class products. */
export const loadBookablePackages = async (): Promise<GroupWithMembers[]> =>
  (await loadPublicGroups()).filter(({ group }) => group.is_package);
