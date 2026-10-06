/** The exact combined capacity of one parent's required children.
 *
 *  Every parent ticket takes one place in each capped group the parent
 *  belongs to. Its one required child line takes one place in each capped
 *  group that child belongs to. The answer is how many whole parent tickets
 *  the children can serve together on one date. Pure data-in, data-out, so
 *  every rule is testable without the site. */

import { requireValue } from "#shared/required-value.ts";

/** One child's part in a parent's combined capacity: the child's group ids
 *  and the child's own per-listing ceiling. */
export type ChildCapacityPart = {
  groupIds: readonly number[];
  ownMax: number;
};

/** The capped groups two listings BOTH belong to — the pool(s) they
 *  contend for. A group with no entry in `byGroup` carries no cap and is
 *  never a pool. */
export const sharedCappedGroupIds = (
  parentGroupIds: readonly number[],
  childGroupIds: readonly number[],
  byGroup: ReadonlyMap<number, number>,
): number[] =>
  parentGroupIds.filter(
    (groupId) => childGroupIds.includes(groupId) && byGroup.has(groupId),
  );

/** The tightest value over the group ids, or `undefined` when the list is
 *  empty. Both pair facts read it, so neither can drift. */
export const minOver = (
  groupIds: readonly number[],
  byGroup: ReadonlyMap<number, number>,
): number | undefined =>
  groupIds.length === 0
    ? undefined
    : Math.min(...groupIds.map((groupId) => byGroup.get(groupId)!));

/** The capacity parts of one parent's required children: each child's groups
 *  read from one listing-to-groups lookup, each child's units from its own
 *  source. */
export const childCapacityPartsFor = <Child>(
  groupIdsByListingId: ReadonlyMap<number, readonly number[]>,
  children: readonly Child[],
  idOf: (child: Child) => number,
  ownMaxOf: (child: Child) => number,
): ChildCapacityPart[] =>
  children.map((child) => ({
    groupIds: groupIdsByListingId.get(idOf(child)) ?? [],
    ownMax: ownMaxOf(child),
  }));

/** One capped child as the feasibility search reads it: the child's own
 *  ceiling and the pools it draws from. */
type CappedChild = { ownMax: number; pools: number[] };

/** The distinct pools a set of capped children draws from. */
const poolIdsFor = (capped: readonly CappedChild[]): number[] => [
  ...new Set(capped.flatMap((child) => child.pools)),
];

/** The pools' places left after the parent's `t` tickets take theirs. */
const residualByPool = (
  pools: readonly number[],
  remainingOf: (groupId: number) => number,
  t: number,
): Map<number, number> => {
  const residual = new Map<number, number>();
  for (const groupId of pools) {
    residual.set(groupId, remainingOf(groupId) - t);
  }
  return residual;
};

/** The largest flow from the children to the pools. Each child sends at
 *  most its own ceiling, and each pool receives at most its residual.
 *
 *  A child's real unit takes one place in EVERY pool the child belongs to.
 *  A flow unit reaches only one pool. The flow can therefore answer higher
 *  than the truth, never lower: any real split is a flow. The search uses
 *  the flow as a cheap reject only, never as the answer. */
const childFlowBound = (
  children: readonly CappedChild[],
  poolIds: readonly number[],
  residual: ReadonlyMap<number, number>,
  need: number,
): number => {
  // Node ids: 0 the source, then the children, then the pools, then the
  // sink. Edge capacity holds what one unit can still cross.
  const poolNode = new Map<number, number>();
  for (const [index, groupId] of poolIds.entries()) {
    poolNode.set(groupId, children.length + 1 + index);
  }
  const sink = children.length + 1 + poolIds.length;
  const capacity: number[][] = Array.from({ length: sink + 1 }, () =>
    Array.from({ length: sink + 1 }, () => 0),
  );
  for (const [index, child] of children.entries()) {
    capacity[0]![index + 1] = child.ownMax;
    for (const groupId of child.pools) {
      capacity[index + 1]![poolNode.get(groupId)!] = need;
    }
  }
  for (const groupId of poolIds) {
    capacity[poolNode.get(groupId)!]![sink] = residual.get(groupId)!;
  }
  let flow = 0;
  // Edmonds-Karp: augment along breadth-first paths until the sink is cut
  // off. The graph has a handful of nodes, so the bound never bites.
  for (;;) {
    const where = breadthFirstPath(capacity, sink);
    if (where[sink] === -1) return flow;
    flow += augmentAlongPath(capacity, where, sink);
    if (flow >= need) return flow;
  }
};

/** The parents of a breadth-first path from the source to each reachable
 *  node. -1 marks the nodes the path never reaches. */
const breadthFirstPath = (
  capacity: readonly (readonly number[])[],
  sink: number,
): number[] => {
  const where: number[] = Array.from({ length: sink + 1 }, () => -1);
  where[0] = 0;
  const queue: number[] = [0];
  for (let head = 0; head < queue.length && where[sink] === -1; head++) {
    const from = queue[head]!;
    for (let to = 1; to <= sink; to++) {
      if (where[to] !== -1 || (capacity[from]![to] ?? 0) <= 0) continue;
      where[to] = from;
      queue.push(to);
    }
  }
  return where;
};

/** Carry the found path's largest possible flow from the sink back to the
 *  source, updating both directions of every edge, and answer the amount
 *  carried. */
const augmentAlongPath = (
  capacity: number[][],
  where: readonly number[],
  sink: number,
): number => {
  // Walk the path once, collecting its edges, then carry the bottleneck
  // across each of them.
  const edges: [number, number][] = [];
  for (let node = sink; node !== 0; node = where[node]!) {
    edges.push([where[node]!, node]);
  }
  let bottleneck = Number.POSITIVE_INFINITY;
  for (const [from, node] of edges) {
    bottleneck = Math.min(bottleneck, capacity[from]![node]!);
  }
  for (const [from, node] of edges) {
    capacity[from]![node]! -= bottleneck;
    capacity[node]![from]! += bottleneck;
  }
  return bottleneck;
};

/** The largest count the child can place here: its own ceiling, the lines
 *  still owed, and the tightest of its pools' free places. */
const roomForChild = (
  child: CappedChild,
  left: number,
  remaining: ReadonlyMap<number, number>,
): number => {
  let room = Math.min(child.ownMax, left);
  for (const groupId of child.pools) {
    room = Math.min(room, remaining.get(groupId) ?? 0);
  }
  return room;
};

/** Whether the children from `index` on can place `left` more lines. The
 *  children walk largest-ceiling first, and the running per-pool spend sits
 *  in `remaining`. `suffix[i]` holds the total ceiling of the children from
 *  `i` on, so a call refuses at once when the tail cannot finish. */
const placeFrom = (
  order: readonly CappedChild[],
  suffix: readonly number[],
  index: number,
  left: number,
  remaining: Map<number, number>,
): boolean => {
  if (left <= 0) return true;
  if (index === order.length) return false;
  if (left > suffix[index]!) return false;
  const child = order[index]!;
  const room = roomForChild(child, left, remaining);
  // The children after this one can carry at most suffix[index + 1] lines,
  // so this child never sits out more than that.
  const floor = Math.max(0, left - suffix[index + 1]!);
  for (let units = room; units >= floor; units--) {
    if (units === 0) {
      if (placeFrom(order, suffix, index + 1, left, remaining)) return true;
      continue;
    }
    spendAcrossPools(remaining, child.pools, -units);
    const placed = placeFrom(order, suffix, index + 1, left - units, remaining);
    spendAcrossPools(remaining, child.pools, units);
    if (placed) return true;
  }
  return false;
};

/** Move `units` of one child's lines across every pool the child draws
 *  from, in place. */
const spendAcrossPools = (
  remaining: Map<number, number>,
  pools: readonly number[],
  units: number,
): void => {
  for (const groupId of pools) {
    remaining.set(groupId, (remaining.get(groupId) ?? 0) + units);
  }
};

/** Whether `need` child lines fit in the pools. The search walks the
 *  children largest-ceiling first, and never tries a count the children
 *  after it cannot finish.
 *
 *  Feasibility is monotone in `need`: if `need` lines fit, fewer fit too.
 *  The caller therefore binary-searches the largest servable quantity
 *  instead of walking every count down. */
const childLinesFit = (
  children: readonly CappedChild[],
  residual: ReadonlyMap<number, number>,
  need: number,
): boolean => {
  if (need <= 0) return true;
  // A flow smaller than the need proves no split can serve it, without
  // enumerating one.
  if (childFlowBound(children, poolIdsFor(children), residual, need) < need) {
    return false;
  }
  const order = [...children].sort((a, b) => b.ownMax - a.ownMax);
  const suffix = new Array<number>(order.length + 1).fill(0);
  for (let index = order.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1]! + order[index]!.ownMax;
  }
  return placeFrom(order, suffix, 0, need, new Map(residual));
};

/** Whether one parent's stored minimum already refuses a date: fewer places
 *  left than the minimum, or required children that together cannot serve
 *  it. An owner can raise the minimum after a booking, so this re-reads the
 *  stored facts the same way the submit fold does. */
export const minimumUnservable = (
  ownRemaining: number,
  minQuantity: number,
  parentGroupIds: readonly number[],
  childParts: readonly ChildCapacityPart[],
  spanRemaining: ReadonlyMap<number, number>,
): boolean => {
  if (ownRemaining < minQuantity) return true;
  if (childParts.length === 0) return false;
  const combined = combinedChildCapacityForParent(
    parentGroupIds,
    childParts,
    spanRemaining,
  );
  return combined < minQuantity;
};

/** The parent tickets a parent's children can serve together — the exact
 *  optimum, not a bound.
 *
 *  The search is bounded twice over. The candidate quantity never exceeds
 *  the parent's own maximum (the tightest shared pool) nor the children's
 *  total ceiling. Feasibility is monotone in the quantity, so a binary
 *  search answers in a handful of checks. Each check prices the pools
 *  first. The flow bound rejects the quantities no split can serve before
 *  the exact search runs.
 *
 *  One child unit consumes one place in every pool the child belongs to.
 *  A plain flow lets one unit split across pools, which under-counts a
 *  multi-pool child — hence the flow only rejects, and the exact search
 *  decides. The inputs stay tiny by domain (a parent's few children and
 *  pools), so the whole answer is cheap even on the largest pages. */
export const combinedChildCapacityForParent = (
  parentGroupIds: readonly number[],
  children: readonly ChildCapacityPart[],
  remainingByGroupId: ReadonlyMap<number, number>,
): number => {
  const poolsOf = (child: ChildCapacityPart): number[] =>
    sharedCappedGroupIds(parentGroupIds, child.groupIds, remainingByGroupId);
  // A child that shares no capped pool binds nothing here: the caller's own
  // ceiling already folded the pools only it sits in.
  let free = 0;
  const capped: CappedChild[] = [];
  for (const child of children) {
    const pools = poolsOf(child);
    if (pools.length === 0) {
      free += child.ownMax;
      continue;
    }
    if (child.ownMax > 0) capped.push({ ownMax: child.ownMax, pools });
  }
  if (capped.length === 0) return free;
  const remainingOf = (groupId: number): number =>
    requireValue(
      remainingByGroupId.get(groupId),
      `Group ${groupId} missing from the remaining map`,
    );
  const ownTotal = free + capped.reduce((sum, child) => sum + child.ownMax, 0);
  const poolIds = poolIdsFor(capped);
  const tightestParentPool = Math.min(...poolIds.map(remainingOf));
  // The largest quantity that can serve. Monotone feasibility turns the
  // walk down from the ceiling into a binary search over [0, ceiling].
  const ceiling = Math.min(ownTotal, tightestParentPool);
  let low = 0;
  let high = ceiling;
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2);
    if (
      childLinesFit(
        capped,
        residualByPool(poolIds, remainingOf, mid),
        mid - free,
      )
    ) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
};
