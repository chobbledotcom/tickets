/** Capacity facts for a parent listing and one of its children that share
 * capped groups: what still fits in the pools the pair contends for. */

import { requireValue } from "#shared/required-value.ts";

/** Units of a shared capped group consumed by one parent+child order. The
 * parent line and its single required child line each take one spot in the
 * group they share (invariants I1, I7). Converts a shared group's remaining
 * spots into how many whole parent+child orders still fit. */
export const PARENT_CHILD_GROUP_UNITS = 2;

/**
 * The capped groups a parent and one of its children BOTH belong to — the pool(s)
 * the combined parent+child demand actually contends for. A capped
 * group is one present in `byGroup` (uncapped groups are omitted from that map).
 * Empty when they share no capped group.
 */
const sharedCappedGroupIds = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  byGroup: ReadonlyMap<number, number>,
): number[] =>
  parentGroupIds.filter((g) => childGroupIds.includes(g) && byGroup.has(g));

/** The tightest value over the shared group ids, or `undefined` when they
 *  share none. Both capacity facts read it, so neither can drift. */
const minOver = (
  ids: number[],
  byGroup: ReadonlyMap<number, number>,
): number | undefined =>
  ids.length === 0 ? undefined : Math.min(...ids.map((g) => byGroup.get(g)!));

/**
 * The remaining spots of the capped group a parent and one of its children
 * share, or `undefined` when they share no capped group. Such a parent and
 * child take two group spots per order, so a caller must reason about the
 * combined demand, not each row alone.
 *
 * The value is the tightest SHARED group's remaining, never the child's
 * tightest group overall. A child that is also in a tighter unshared group
 * must not drag this down to an unrelated cap. Discovery and the booking-page
 * quantity ceiling both read it, so the two surfaces cannot disagree.
 */
export const sharedGroupRemaining = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  remainingByGroupId: ReadonlyMap<number, number>,
): number | undefined => {
  const shared = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    remainingByGroupId,
  );
  return minOver(shared, remainingByGroupId);
};

/** One child's part in a parent's combined capacity: the child's group ids and
 *  the child's own per-listing ceiling. */
export type ChildCapacityPart = {
  groupIds: readonly number[];
  ownMax: number;
};

/** The capacity parts of one parent's required children: each child's groups
 *  read from one listing-to-groups lookup, each child's units from its own
 *  source. */
export const childCapacityPartsFor =
  (groupIdsByListingId: ReadonlyMap<number, readonly number[]>) =>
  <Child>(
    children: readonly Child[],
    idOf: (child: Child) => number,
    ownMaxOf: (child: Child) => number,
  ): ChildCapacityPart[] =>
    children.map((child) => ({
      groupIds: groupIdsByListingId.get(idOf(child)) ?? [],
      ownMax: ownMaxOf(child),
    }));

/** Whether `t` parent tickets are servable: the parent's own `t` places come
 *  out of every shared pool first, then a depth-first split of the remaining
 *  child lines over `capped` must keep every pool within its residual.
 *  Largest ceilings try first, so the tight pools prune early. */
const splitFits = (
  pools: readonly number[],
  capped: readonly { ownMax: number; pools: number[] }[],
  free: number,
  remainingOf: (groupId: number) => number,
  t: number,
): boolean => {
  const residual = new Map(
    pools.map((groupId) => [groupId, remainingOf(groupId) - t]),
  );
  if (pools.some((groupId) => (residual.get(groupId) ?? 0) < 0)) return false;
  const need = t - free;
  if (need <= 0) return true;
  if (capped.reduce((sum, child) => sum + child.ownMax, 0) < need) {
    return false;
  }
  const order = [...capped].sort((a, b) => b.ownMax - a.ownMax);
  const adjust = (child: { pools: number[] }, units: number): void => {
    for (const groupId of child.pools) {
      residual.set(groupId, (residual.get(groupId) ?? 0) + units);
    }
  };
  const assign = (index: number, left: number): boolean => {
    if (index === order.length) return left === 0;
    const child = order[index]!;
    const room = Math.min(
      child.ownMax,
      left,
      ...child.pools.map((groupId) => residual.get(groupId)!),
    );
    for (let units = room; units >= 0; units--) {
      adjust(child, -units);
      const placed = assign(index + 1, left - units);
      adjust(child, units);
      if (placed) return true;
    }
    return false;
  };
  return assign(0, need);
};

/** The parent tickets a parent's children can serve together — the exact
 *  optimum, not a bound. Every parent ticket takes one place in each capped
 *  group the parent belongs to. Its one required child line takes one place
 *  in each capped group that child belongs to. T tickets are servable exactly
 *  when some split of the T child lines over the children keeps every shared
 *  pool within its places. The search walks T down from the tightest upper
 *  bound; the inputs are tiny by domain (a parent's few children and pools),
 *  so the search is cheap and the answer needs no bound. */
export const combinedChildCapacityForParent = (
  parentGroupIds: readonly number[],
  children: readonly ChildCapacityPart[],
  remainingByGroupId: ReadonlyMap<number, number>,
): number => {
  const sharedPoolsOf = (child: ChildCapacityPart): number[] =>
    sharedCappedGroupIds(parentGroupIds, child.groupIds, remainingByGroupId);
  // A child that shares no capped pool binds nothing here: the caller's own
  // ceiling already folded the pools only it sits in.
  const free = children.reduce(
    (sum, child) =>
      sharedPoolsOf(child).length === 0 ? sum + child.ownMax : sum,
    0,
  );
  const capped = children
    .map((child) => ({ ownMax: child.ownMax, pools: sharedPoolsOf(child) }))
    .filter((child) => child.pools.length > 0 && child.ownMax > 0);
  const pools = [...new Set(capped.flatMap((child) => child.pools))];
  if (pools.length === 0) return free;
  const remainingOf = (groupId: number): number =>
    requireValue(
      remainingByGroupId.get(groupId),
      `Group ${groupId} missing from the remaining map`,
    );
  const ownTotal = free + capped.reduce((sum, child) => sum + child.ownMax, 0);
  const tightestParentPool = Math.min(
    ...pools.map((groupId) => remainingOf(groupId)),
  );
  for (let t = Math.min(ownTotal, tightestParentPool); t > 0; t--) {
    if (splitFits(pools, capped, free, remainingOf, t)) return t;
  }
  return 0;
};

/**
 * The capacity a parent and one of its children share, as two separate facts:
 * - `staticCap` — `groups.max_attendees`, date-INDEPENDENT. Below
 *   {@link PARENT_CHILD_GROUP_UNITS} a parent+child order can never fit on any
 *   date, so a date-less surface can mark it sold out.
 * - `remaining` — free spots in the caller's context, `undefined` when it is
 *   not computable, such as a daily child with no submitted date.
 *
 * Both are `undefined` when the two share no capped group.
 */
export type SharedGroupCapacity = {
  staticCap: number | undefined;
  remaining: number | undefined;
};

/** The group ids each listing belongs to (listing id → group ids). A listing
 * absent from the map belongs to no group. */
export type GroupIdsByListingId = ReadonlyMap<number, number[]>;

/**
 * Build the {@link SharedGroupCapacity} for a parent/child pair. The two are
 * co-grouped when their group sets meet in at least one capped group.
 *
 * Both facts come from the SAME shared groups, and are the tightest value over
 * those — never the child's tightest group overall. That is what lets a
 * date-less surface reject a share too small to hold both, even when a daily
 * child's per-date remaining is unknown.
 */
export const sharedGroupCapacity = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  staticCapByGroupId: ReadonlyMap<number, number>,
  remainingByGroupId: ReadonlyMap<number, number>,
): SharedGroupCapacity => {
  const sharedForCap = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    staticCapByGroupId,
  );
  const sharedForRemaining = sharedCappedGroupIds(
    parentGroupIds,
    childGroupIds,
    remainingByGroupId,
  );
  return {
    remaining: minOver(sharedForRemaining, remainingByGroupId),
    staticCap: minOver(sharedForCap, staticCapByGroupId),
  };
};
