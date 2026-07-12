import { sumByKey, sumOf } from "#fp";
import { packageQuantityLimit } from "#shared/booking/capacity-tree.ts";
import {
  childActive,
  childInStock,
  childOpen,
  childPassesAllChecks,
  type TicketListing,
  ticketsThatFitInPool,
} from "#shared/booking/model.ts";
import type { TreePackage } from "#shared/booking/page-packages.ts";
import {
  type BookingTree,
  fixedQuantitiesByListingId,
  packageSubTree,
} from "#shared/booking/tree.ts";
import { hasDateLessCap } from "#shared/capacity-rules.ts";
import {
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupRemaining,
} from "#shared/types.ts";

/** Spots still free in each capacity group, keyed by group id. */
type GroupRemaining = ReadonlyMap<number, number>;
/** The group ids each listing belongs to, keyed by listing id. */
type GroupIdsByListing = ReadonlyMap<number, number[]>;

export type GroupCapacityInfo = {
  groupRemainingByGroupId: GroupRemaining;
  groupIdsByListingId: GroupIdsByListing;
};

export type PackageLimitInfo = GroupCapacityInfo & {
  listings: readonly TicketListing[];
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined;
};

export const groupCapacityInfo = (
  groupRemainingByGroupId: GroupRemaining,
  groupIdsByListingId: GroupIdsByListing,
): GroupCapacityInfo => ({ groupIdsByListingId, groupRemainingByGroupId });

export const packageLimitInfo = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined,
  groupRemainingByGroupId: GroupRemaining,
  groupIdsByListingId: GroupIdsByListing,
): PackageLimitInfo => ({
  childrenByParentId,
  listings,
  ...groupCapacityInfo(groupRemainingByGroupId, groupIdsByListingId),
});

/** Each page package's whole-bundle limit, keyed by group id. Builds the
 * page-level {@link PackageLimitInfo} once and maps each package over
 * {@link pagePackageBundleLimit}, so callers stop re-stating the four
 * limit-info arguments per call site. */
export const pageBundleLimits = (
  tree: BookingTree,
  packages: readonly TreePackage[],
  page: PackageLimitInfo,
): Map<number, number> =>
  new Map(
    packages.map((pkg) => [
      pkg.groupId,
      pagePackageBundleLimit(tree, pkg, page),
    ]),
  );

export const childCanBeBooked: (child: TicketListing) => boolean =
  childPassesAllChecks([childActive, childOpen, childInStock]);

/** A child without the `dateLessCap` rule has no date-less stock ceiling of
 * its own, so only the parent's limit clamps the pair before a date is
 * known. */
const childOwnTicketLimit = (
  parent: TicketListing,
  child: TicketListing,
): number =>
  hasDateLessCap(child.listing) ? child.maxPurchasable : parent.maxPurchasable;

const groupIdsFor = (
  ctx: GroupCapacityInfo,
  listing: TicketListing,
): number[] => ctx.groupIdsByListingId.get(listing.listing.id) ?? [];

const sharedSeatsLeftFor = (
  ctx: GroupCapacityInfo,
  parent: TicketListing,
  child: TicketListing,
): number | undefined =>
  sharedGroupRemaining(
    groupIdsFor(ctx, parent),
    groupIdsFor(ctx, child),
    ctx.groupRemainingByGroupId,
  );

/** Tickets this child can still offer with this parent. */
export const childTicketLimit = (
  parent: TicketListing,
  child: TicketListing,
  ctx: GroupCapacityInfo,
): number => {
  const shared = sharedSeatsLeftFor(ctx, parent, child);
  return shared === undefined
    ? childOwnTicketLimit(parent, child)
    : Math.min(
        ticketsThatFitInPool(shared, PARENT_CHILD_GROUP_UNITS),
        childOwnTicketLimit(parent, child),
      );
};

const sharedGroupTicketLimit = (
  spotsLeft: number,
  childOwnLimitTotal: number,
): number => Math.min(spotsLeft, childOwnLimitTotal);

type ChildLimitPart =
  | { kind: "own"; ownLimit: number }
  | { kind: "parentGroup"; ownLimit: number; spotsLeft: number }
  | { kind: "childGroup"; groupId: number; ownLimit: number };

type MemberWithChildren = {
  member: TicketListing;
  children: readonly TicketListing[];
};

type ChildrenToBook = {
  children: TicketListing[];
  packageQty: number;
};

type OneChildNeed = {
  childId: number;
  childLimit: number;
  ticketsNeeded: number;
};

type GroupNeed = {
  groupId: number;
  ticketsNeeded: number;
};

const usesParentGroup = (
  part: ChildLimitPart,
): part is Extract<ChildLimitPart, { kind: "parentGroup" }> =>
  part.kind === "parentGroup";

const usesChildGroup = (
  part: ChildLimitPart,
): part is Extract<ChildLimitPart, { kind: "childGroup" }> =>
  part.kind === "childGroup";

const usesOnlyChildLimit = (
  part: ChildLimitPart,
): part is Extract<ChildLimitPart, { kind: "own" }> => part.kind === "own";

const limitedGroupsFor = (
  ctx: GroupCapacityInfo,
  child: TicketListing,
): { groupId: number; remaining: number }[] =>
  groupIdsFor(ctx, child)
    .filter((groupId) => ctx.groupRemainingByGroupId.has(groupId))
    .map((groupId) => ({
      groupId,
      remaining: ctx.groupRemainingByGroupId.get(groupId)!,
    }));

const smallestLimitedGroupFor = (
  ctx: GroupCapacityInfo,
  child: TicketListing,
): { groupId: number; remaining: number } | null =>
  limitedGroupsFor(ctx, child).toSorted(
    (a, b) => a.remaining - b.remaining,
  )[0] ?? null;

const childLimitPart = (
  ctx: GroupCapacityInfo,
  parent: TicketListing,
  child: TicketListing,
): ChildLimitPart => {
  const ownLimit = childOwnTicketLimit(parent, child);
  const shared = sharedSeatsLeftFor(ctx, parent, child);
  if (shared !== undefined) {
    return { kind: "parentGroup", ownLimit, spotsLeft: shared };
  }
  const limitedGroup = smallestLimitedGroupFor(ctx, child);
  return limitedGroup === null
    ? { kind: "own", ownLimit }
    : { groupId: limitedGroup.groupId, kind: "childGroup", ownLimit };
};

const parentGroupChildLimit = (parts: readonly ChildLimitPart[]): number => {
  const shared = parts.filter(usesParentGroup);
  if (shared.length === 0) return 0;
  return Math.min(
    ticketsThatFitInPool(
      Math.min(...shared.map((part) => part.spotsLeft)),
      PARENT_CHILD_GROUP_UNITS,
    ),
    sumOf((part: ChildLimitPart) => part.ownLimit)(shared),
  );
};

const childGroupLimit = (
  ctx: GroupCapacityInfo,
  parts: readonly ChildLimitPart[],
): number =>
  sumOf(([groupId, ownLimit]: [number, number]) =>
    sharedGroupTicketLimit(ctx.groupRemainingByGroupId.get(groupId)!, ownLimit),
  )([
    ...sumByKey(
      (part: Extract<ChildLimitPart, { kind: "childGroup" }>) => part.groupId,
      (part) => part.ownLimit,
    )(parts.filter(usesChildGroup)),
  ]);

const childrenTicketLimit = (
  ctx: GroupCapacityInfo,
  parent: TicketListing,
  bookable: readonly TicketListing[],
): number => {
  const parts = bookable.map((child) => childLimitPart(ctx, parent, child));
  return (
    sumOf((part: ChildLimitPart) => part.ownLimit)(
      parts.filter(usesOnlyChildLimit),
    ) +
    parentGroupChildLimit(parts) +
    childGroupLimit(ctx, parts)
  );
};

const membersWithChildren = (ctx: PackageLimitInfo): MemberWithChildren[] =>
  ctx.childrenByParentId === undefined
    ? []
    : ctx.listings.flatMap((member) => {
        const children = ctx.childrenByParentId!.get(member.listing.id);
        return !children || children.length === 0 ? [] : [{ children, member }];
      });

/** Ticket limits for package members that also need child tickets. */
export const packageChildTicketLimits = (
  ctx: PackageLimitInfo,
): Map<number, number> =>
  new Map(
    membersWithChildren(ctx).map(({ member, children }) => [
      member.listing.id,
      childrenTicketLimit(ctx, member, children.filter(childCanBeBooked)),
    ]),
  );

const groupsEveryChildUses = (
  ctx: GroupCapacityInfo,
  bookable: readonly TicketListing[],
): number[] => {
  const [firstChildIds, ...restChildIds] = bookable.map(
    (child) =>
      new Set(limitedGroupsFor(ctx, child).map(({ groupId }) => groupId)),
  );
  return [...firstChildIds!].filter((groupId) =>
    restChildIds.every((ids) => ids.has(groupId)),
  );
};

const packageChildrenToBook = (
  tree: BookingTree,
  ctx: PackageLimitInfo,
): ChildrenToBook[] => {
  const memberQty = fixedQuantitiesByListingId(tree);
  return membersWithChildren(ctx)
    .map(({ member, children }) => ({
      children: children.filter(childCanBeBooked),
      packageQty: memberQty.get(member.listing.id)!,
    }))
    .filter(({ children }) => children.length > 0);
};

const oneChildNeed = ({
  children,
  packageQty,
}: ChildrenToBook): OneChildNeed[] => {
  const sole = children.length === 1 ? children[0]! : null;
  // Only a dateLessCap child has a date-less own limit to count against.
  return sole && hasDateLessCap(sole.listing)
    ? [
        {
          childId: sole.listing.id,
          childLimit: sole.maxPurchasable,
          ticketsNeeded: packageQty,
        },
      ]
    : [];
};

const groupNeedsFor =
  (ctx: GroupCapacityInfo) =>
  ({ children, packageQty }: ChildrenToBook): GroupNeed[] =>
    groupsEveryChildUses(ctx, children).map((groupId) => ({
      groupId,
      ticketsNeeded: packageQty,
    }));

const singleChildLimits = (needs: readonly OneChildNeed[]): number[] => {
  const limitByChildId = new Map(
    needs.map(({ childId, childLimit }) => [childId, childLimit]),
  );
  return [
    ...sumByKey<OneChildNeed, number>(
      (need) => need.childId,
      (need) => need.ticketsNeeded,
    )(needs),
  ].map(([childId, ticketsNeeded]) =>
    ticketsThatFitInPool(limitByChildId.get(childId)!, ticketsNeeded),
  );
};

const sharedChildGroupLimits = (
  ctx: GroupCapacityInfo,
  needs: readonly GroupNeed[],
): number[] =>
  [
    ...sumByKey<GroupNeed, number>(
      (need) => need.groupId,
      (need) => need.ticketsNeeded,
    )(needs),
  ].map(([groupId, ticketsNeeded]) =>
    ticketsThatFitInPool(
      ctx.groupRemainingByGroupId.get(groupId)!,
      ticketsNeeded,
    ),
  );

const sharedChildrenAcrossMembersLimit = (
  tree: BookingTree,
  ctx: PackageLimitInfo,
): number => {
  const childrenToBook = packageChildrenToBook(tree, ctx);
  const limits = [
    ...singleChildLimits(childrenToBook.flatMap(oneChildNeed)),
    ...sharedChildGroupLimits(ctx, childrenToBook.flatMap(groupNeedsFor(ctx))),
  ];
  return Math.min(Number.POSITIVE_INFINITY, ...limits);
};

/** Whole packages the buyer may still book. */
export const packageBundleLimit = (
  tree: BookingTree,
  ctx: PackageLimitInfo,
): number =>
  Math.min(
    packageQuantityLimit(
      tree,
      new Map(ctx.listings.map((listing) => [listing.listing.id, listing])),
      ctx.groupRemainingByGroupId,
      ctx.groupIdsByListingId,
      packageChildTicketLimits(ctx),
    ),
    sharedChildrenAcrossMembersLimit(tree, ctx),
  );

/** Whole bundles of ONE page package the buyer may still book, on a page that
 * can sell several bundles alongside other listings: {@link packageBundleLimit}
 * over just that package's member nodes and member listings (`page` carries the
 * whole page's limit info; the member listings are narrowed here). The one
 * ceiling the page render, the submit clamp, and the API all share. A package
 * with no member node on this page (every member dropped, e.g. as another
 * listing's child) sells nothing, so its limit is 0 — never `Math.min()`'s
 * Infinity. */
export const pagePackageBundleLimit = (
  tree: BookingTree,
  pkg: TreePackage,
  page: PackageLimitInfo,
): number => {
  const memberIds = new Set(pkg.memberListingIds);
  const subTree = packageSubTree(tree, pkg.groupId);
  if (subTree.nodes.length === 0) return 0;
  return packageBundleLimit(subTree, {
    ...page,
    listings: page.listings.filter((info) => memberIds.has(info.listing.id)),
  });
};
