/** Loads public group members and decides which group booking links work. */

/* jscpd:ignore-start */
import { requiredMapValue, unique, uniqueBy } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import {
  packageBundleLimit,
  packageLimitInfo,
} from "#shared/booking/package-cap.ts";
import {
  getDatelessGroupRemaining,
  remainingByListingOverGroups,
} from "#shared/db/attendees/capacity.ts";
import {
  getActiveListingsByGroupId,
  getActiveListingsByGroupIds,
  getGroupIdsByListingIds,
  getGroupPackagePricesByGroupIds,
  getHiddenPackageMemberIds,
  groups,
  packageMemberMaps,
} from "#shared/db/groups.ts";
import { getChildrenForParents } from "#shared/db/listing-parents.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import {
  classifyForDiscovery,
  type DiscoveryClassification,
  dropHiddenPackageMembers,
} from "./discovery.ts";

/* jscpd:ignore-end */

/** A group's members as buyers may see them on that group's own surfaces. A
 * package keeps its full membership; a regular group drops hidden-package
 * members, which belong only to that package. */
const visibleGroupMembers = <T extends { id: number }>(
  group: { is_package: boolean },
  members: T[],
): Promise<T[]> =>
  group.is_package
    ? Promise.resolve(members)
    : dropHiddenPackageMembers(members);

/** Load one group's buyer-visible active members. */
export const getVisibleGroupMembers = async (
  group: Group,
): Promise<ListingWithCount[]> =>
  visibleGroupMembers(group, await getActiveListingsByGroupId(group.id));

type MembersByGroup = ReadonlyMap<number, readonly ListingWithCount[]>;

type GroupMemberOperation<Result> = (
  groupList: readonly Group[],
  membersByGroup: MembersByGroup,
) => Promise<Result>;

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
  getActiveListingsByGroupIds(groupList.map((group) => group.id));

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

/** Apply hidden-package privacy to already-batched member rows. */
const visibleGroupMembersFrom: GroupMemberOperation<
  Map<number, ListingWithCount[]>
> = async (groupList, membersByGroup) => {
  const regularMemberIds = unique(
    groupList
      .filter((group) => !group.is_package)
      .flatMap((group) =>
        membersOf(group, membersByGroup).map((member) => member.id),
      ),
  );
  const hidden = await getHiddenPackageMemberIds(regularMemberIds);
  return new Map(
    groupList.map((group) => [
      group.id,
      group.is_package
        ? [...membersOf(group, membersByGroup)]
        : membersOf(group, membersByGroup).filter(
            (member) => !hidden.has(member.id),
          ),
    ]),
  );
};

/** Buyer-visible active members of several groups, loaded in a bounded number
 * of reads rather than one member and privacy query per group. */
export const getVisibleGroupMembersByGroupIds: LoadGroupMembers = async (
  groupList,
) => {
  const membersByGroup = await activeMembersByGroup(groupList);
  return visibleGroupMembersFrom(groupList, membersByGroup);
};

const groupHasBookableMember = (
  members: readonly ListingWithCount[],
  { childIds, soldOutParentIds }: DiscoveryClassification,
): boolean =>
  members.some(
    (member) => !childIds.has(member.id) && !soldOutParentIds.has(member.id),
  );

/** Shows every complete package whose whole bundle still fits. Member prices,
 * children, memberships, and capacity are loaded once for the full package set;
 * each package then runs the same booking-tree limit over its own members. */
const bookablePackageIds = async (
  packages: readonly Group[],
  membersByGroup: MembersByGroup,
): Promise<number[]> => {
  if (packages.length === 0) return [];
  const packageMembers = uniqueMembersFor(packages, membersByGroup);
  const [rowsByGroup, childrenByParent] = await Promise.all([
    getGroupPackagePricesByGroupIds(packages.map((group) => group.id)),
    getChildrenForParents(packageMembers.map((member) => member.id)),
  ]);
  const limitListings = uniqueBy((listing: ListingWithCount) => listing.id)([
    ...packageMembers,
    ...[...childrenByParent.values()].flat(),
  ]);
  const groupIdsByListingId = await getGroupIdsByListingIds(
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
  const childrenByParentId = new Map(
    [...childrenByParent].map(([parentId, children]) => [
      parentId,
      children.map(toTicketListing),
    ]),
  );
  return packages
    .filter((group) => {
      const members = membersOf(group, membersByGroup);
      const rows = rowsByGroup.get(group.id) ?? [];
      if (members.length === 0 || members.length < rows.length) return false;
      const ticketListings = members.map(toTicketListing);
      const maps = packageMemberMaps(rows);
      const tree = buildBookingTree({
        childrenByParentId,
        listings: ticketListings,
        packages: [
          {
            dayPrices: new Map(),
            groupId: group.id,
            hideListings: false,
            memberListingIds: members.map((member) => member.id),
            prices: maps.prices,
            quantities: maps.quantities,
          },
        ],
        slugs: members.map((member) => member.slug),
      });
      return (
        packageBundleLimit(
          tree,
          packageLimitInfo(
            ticketListings,
            childrenByParentId,
            remaining,
            groupIdsByListingId,
          ),
        ) >= 1
      );
    })
    .map((group) => group.id);
};

/** Decide several groups from one shared member load and one classification of
 * all regular members. Package-specific trees share their database facts. */
const getBookableGroupIds: GroupMemberOperation<ReadonlySet<number>> = async (
  groupList,
  membersByGroup,
) => {
  const { packages, regular } = groupKinds(groupList);
  const regularMembers = uniqueMembersFor(regular, membersByGroup);
  const [classification, packageIds] = await Promise.all([
    regularMembers.length > 0
      ? classifyForDiscovery(regularMembers)
      : Promise.resolve(null),
    bookablePackageIds(packages, membersByGroup),
  ]);
  const regularIds = classification
    ? regular
        .filter((group) =>
          groupHasBookableMember(
            membersOf(group, membersByGroup),
            classification,
          ),
        )
        .map((group) => group.id)
    : [];
  return new Set([...regularIds, ...packageIds]);
};

/** Whether one group's public booking page can accept a booking. */
export const groupBookable = async (
  group: Group,
  members: readonly ListingWithCount[],
): Promise<boolean> =>
  (await getBookableGroupIds([group], new Map([[group.id, members]]))).has(
    group.id,
  );

const visibleBookableGroupIds: GroupMemberOperation<
  ReadonlySet<number>
> = async (groupList, membersByGroup) =>
  getBookableGroupIds(
    groupList,
    await visibleGroupMembersFrom(groupList, membersByGroup),
  );

/** Load and decide several groups while overlapping package checks with the
 * hidden-member lookup regular groups need. */
export const loadBookableGroupIds = async (
  groupList: readonly Group[],
): Promise<ReadonlySet<number>> => {
  const membersByGroup = await activeMembersByGroup(groupList);
  const { packages, regular } = groupKinds(groupList);
  const [packageIds, regularIds] = await Promise.all([
    getBookableGroupIds(packages, membersByGroup),
    visibleBookableGroupIds(regular, membersByGroup),
  ]);
  return new Set([...packageIds, ...regularIds]);
};

/** Load non-hidden groups whose Book link leads to a bookable page. */
export const loadPublicGroups = async (): Promise<Group[]> => {
  const visibleGroups = (await groups.cache.getAll()).filter(
    (group) => !group.hidden,
  );
  const bookableIds = await loadBookableGroupIds(visibleGroups);
  return visibleGroups.filter((group) => bookableIds.has(group.id));
};

/** Packages a public surface can advertise as first-class products. */
export const loadBookablePackages = async (): Promise<Group[]> =>
  (await loadPublicGroups()).filter((group) => group.is_package);
