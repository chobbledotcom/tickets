import { sumByKey, sumOf } from "#fp";
import { packageQuantityCap } from "#shared/booking/capacity-tree.ts";
import {
  childActive,
  childInStock,
  childOpen,
  groupPoolUnits,
  selectableChild,
  type TicketListing,
} from "#shared/booking/model.ts";
import {
  type BookingTree,
  fixedQuantitiesByListingId,
} from "#shared/booking/tree.ts";
import {
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupRemaining,
} from "#shared/types.ts";

export type GroupCapacityContext = {
  groupRemainingByGroupId: ReadonlyMap<number, number>;
  groupIdsByListingId: ReadonlyMap<number, number[]>;
};

export type PackageCapContext = GroupCapacityContext & {
  listings: readonly TicketListing[];
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined;
};

export const groupCapacityContext = (
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
): GroupCapacityContext => ({ groupIdsByListingId, groupRemainingByGroupId });

export const packageCapContext = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, readonly TicketListing[]> | undefined,
  groupRemainingByGroupId: ReadonlyMap<number, number>,
  groupIdsByListingId: ReadonlyMap<number, number[]>,
): PackageCapContext => ({
  childrenByParentId,
  listings,
  ...groupCapacityContext(groupRemainingByGroupId, groupIdsByListingId),
});

export const childBookable: (child: TicketListing) => boolean = selectableChild(
  [childActive, childOpen, childInStock],
);

const childOwnRenderCap = (
  parent: TicketListing,
  child: TicketListing,
): number =>
  child.listing.listing_type === "daily"
    ? parent.maxPurchasable
    : child.maxPurchasable;

const groupIdsFor = (
  ctx: GroupCapacityContext,
  listing: TicketListing,
): number[] => ctx.groupIdsByListingId.get(listing.listing.id) ?? [];

const sharedRemainingFor = (
  ctx: GroupCapacityContext,
  parent: TicketListing,
  child: TicketListing,
): number | undefined =>
  sharedGroupRemaining(
    groupIdsFor(ctx, parent),
    groupIdsFor(ctx, child),
    ctx.groupRemainingByGroupId,
  );

export const childOrderCap = (
  parent: TicketListing,
  child: TicketListing,
  ctx: GroupCapacityContext,
): number => {
  const shared = sharedRemainingFor(ctx, parent, child);
  return shared === undefined
    ? childOwnRenderCap(parent, child)
    : Math.min(
        groupPoolUnits(shared, PARENT_CHILD_GROUP_UNITS),
        childOwnRenderCap(parent, child),
      );
};

const cappedGroupCohortCap = (remaining: number, ownCapSum: number): number =>
  Math.min(remaining, ownCapSum);

type ChildCapContribution =
  | { kind: "uncapped"; ownCap: number }
  | { kind: "shared"; ownCap: number; remaining: number }
  | { kind: "group"; groupId: number; ownCap: number };

type PackageMemberChildren = {
  member: TicketListing;
  children: readonly TicketListing[];
};

type ChildDemand = {
  bookable: TicketListing[];
  qty: number;
};

type SoleChildDemand = {
  childId: number;
  cap: number;
  demand: number;
};

type GroupDemand = {
  groupId: number;
  demand: number;
};

const isSharedContribution = (
  contribution: ChildCapContribution,
): contribution is Extract<ChildCapContribution, { kind: "shared" }> =>
  contribution.kind === "shared";

const isGroupContribution = (
  contribution: ChildCapContribution,
): contribution is Extract<ChildCapContribution, { kind: "group" }> =>
  contribution.kind === "group";

const isUncappedContribution = (
  contribution: ChildCapContribution,
): contribution is Extract<ChildCapContribution, { kind: "uncapped" }> =>
  contribution.kind === "uncapped";

const cappedGroupsFor = (
  ctx: GroupCapacityContext,
  child: TicketListing,
): { groupId: number; remaining: number }[] =>
  groupIdsFor(ctx, child)
    .filter((groupId) => ctx.groupRemainingByGroupId.has(groupId))
    .map((groupId) => ({
      groupId,
      remaining: ctx.groupRemainingByGroupId.get(groupId)!,
    }));

const tightestCappedGroupFor = (
  ctx: GroupCapacityContext,
  child: TicketListing,
): { groupId: number; remaining: number } | null =>
  cappedGroupsFor(ctx, child).toSorted(
    (a, b) => a.remaining - b.remaining,
  )[0] ?? null;

const childCapContribution = (
  ctx: GroupCapacityContext,
  parent: TicketListing,
  child: TicketListing,
): ChildCapContribution => {
  const ownCap = childOwnRenderCap(parent, child);
  const shared = sharedRemainingFor(ctx, parent, child);
  if (shared !== undefined)
    return { kind: "shared", ownCap, remaining: shared };
  const cappedGroup = tightestCappedGroupFor(ctx, child);
  return cappedGroup === null
    ? { kind: "uncapped", ownCap }
    : { groupId: cappedGroup.groupId, kind: "group", ownCap };
};

const sharedCohortCap = (
  contributions: readonly ChildCapContribution[],
): number => {
  const shared = contributions.filter(isSharedContribution);
  if (shared.length === 0) return 0;
  return Math.min(
    groupPoolUnits(
      Math.min(...shared.map((contribution) => contribution.remaining)),
      PARENT_CHILD_GROUP_UNITS,
    ),
    sumOf((contribution: ChildCapContribution) => contribution.ownCap)(shared),
  );
};

const cappedGroupsCap = (
  ctx: GroupCapacityContext,
  contributions: readonly ChildCapContribution[],
): number =>
  sumOf(([groupId, ownCap]: [number, number]) =>
    cappedGroupCohortCap(ctx.groupRemainingByGroupId.get(groupId)!, ownCap),
  )([
    ...sumByKey(
      (contribution: Extract<ChildCapContribution, { kind: "group" }>) =>
        contribution.groupId,
      (contribution) => contribution.ownCap,
    )(contributions.filter(isGroupContribution)),
  ]);

const childCombinedCap = (
  ctx: GroupCapacityContext,
  parent: TicketListing,
  bookable: readonly TicketListing[],
): number => {
  const contributions = bookable.map((child) =>
    childCapContribution(ctx, parent, child),
  );
  return (
    sumOf((contribution: ChildCapContribution) => contribution.ownCap)(
      contributions.filter(isUncappedContribution),
    ) +
    sharedCohortCap(contributions) +
    cappedGroupsCap(ctx, contributions)
  );
};

const packageMembersWithChildren = (
  ctx: PackageCapContext,
): PackageMemberChildren[] =>
  ctx.childrenByParentId === undefined
    ? []
    : ctx.listings.flatMap((member) => {
        const children = ctx.childrenByParentId!.get(member.listing.id);
        return !children || children.length === 0 ? [] : [{ children, member }];
      });

export const packageChildUnitCaps = (
  ctx: PackageCapContext,
): Map<number, number> =>
  new Map(
    packageMembersWithChildren(ctx).map(({ member, children }) => [
      member.listing.id,
      childCombinedCap(ctx, member, children.filter(childBookable)),
    ]),
  );

const cappedGroupsOfAllChildren = (
  ctx: GroupCapacityContext,
  bookable: readonly TicketListing[],
): number[] => {
  const [firstChildIds, ...restChildIds] = bookable.map(
    (child) =>
      new Set(cappedGroupsFor(ctx, child).map(({ groupId }) => groupId)),
  );
  return [...firstChildIds!].filter((groupId) =>
    restChildIds.every((ids) => ids.has(groupId)),
  );
};

const packageChildDemands = (
  tree: BookingTree,
  ctx: PackageCapContext,
): ChildDemand[] => {
  const memberQty = fixedQuantitiesByListingId(tree);
  return packageMembersWithChildren(ctx)
    .map(({ member, children }) => ({
      bookable: children.filter(childBookable),
      qty: memberQty.get(member.listing.id)!,
    }))
    .filter(({ bookable }) => bookable.length > 0);
};

const soleChildDemand = ({ bookable, qty }: ChildDemand): SoleChildDemand[] => {
  const sole = bookable.length === 1 ? bookable[0]! : null;
  return sole && sole.listing.listing_type !== "daily"
    ? [{ cap: sole.maxPurchasable, childId: sole.listing.id, demand: qty }]
    : [];
};

const groupDemandsFor =
  (ctx: GroupCapacityContext) =>
  ({ bookable, qty }: ChildDemand): GroupDemand[] =>
    cappedGroupsOfAllChildren(ctx, bookable).map((groupId) => ({
      demand: qty,
      groupId,
    }));

const demandPoolUnits = (demands: readonly SoleChildDemand[]): number[] => {
  const capByChildId = new Map(
    demands.map(({ cap, childId }) => [childId, cap]),
  );
  return [
    ...sumByKey<SoleChildDemand, number>(
      (demand) => demand.childId,
      (demand) => demand.demand,
    )(demands),
  ].map(([childId, demand]) =>
    groupPoolUnits(capByChildId.get(childId)!, demand),
  );
};

const groupPoolDemandUnits = (
  ctx: GroupCapacityContext,
  demands: readonly GroupDemand[],
): number[] =>
  [
    ...sumByKey<GroupDemand, number>(
      (demand) => demand.groupId,
      (demand) => demand.demand,
    )(demands),
  ].map(([groupId, demand]) =>
    groupPoolUnits(ctx.groupRemainingByGroupId.get(groupId)!, demand),
  );

const crossParentChildDemandCap = (
  tree: BookingTree,
  ctx: PackageCapContext,
): number => {
  const demands = packageChildDemands(tree, ctx);
  const poolUnits = [
    ...demandPoolUnits(demands.flatMap(soleChildDemand)),
    ...groupPoolDemandUnits(ctx, demands.flatMap(groupDemandsFor(ctx))),
  ];
  return Math.min(Number.POSITIVE_INFINITY, ...poolUnits);
};

/** The whole-bundle count cap shared by render, submit, API, and discovery. */
export const packageBundleCap = (
  tree: BookingTree,
  ctx: PackageCapContext,
): number =>
  Math.min(
    packageQuantityCap(
      tree,
      new Map(ctx.listings.map((listing) => [listing.listing.id, listing])),
      ctx.groupRemainingByGroupId,
      ctx.groupIdsByListingId,
      packageChildUnitCaps(ctx),
    ),
    crossParentChildDemandCap(tree, ctx),
  );
