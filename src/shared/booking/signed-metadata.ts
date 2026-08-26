import {
  type BookingNode,
  type BookingTree,
  childNodeKey,
  groupMemberNodeKey,
  listingNodeKey,
  packageMemberNodeKey,
} from "#booking/tree.ts";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { mapNotNullish } from "#fp";
import type { BookingItem } from "#shared/booking-intent.ts";

/**
 * The tag lets the webhook reconstruct a line's canonical `nodeKey` and re-check
 * it against current config, which catches an operator who removed or swapped
 * an edge while the buyer's checkout was open.
 *
 * It is deliberately tiny (`k` one char, `r` a group id), so nested-package
 * metadata still fits the provider entry and value caps.
 *
 * Only a *package member* line needs one. A folded child rides in `allocations`
 * instead, because a child reached under two parents collapses to one line.
 */

/** The compact edge fields spread onto a {@link BookingItem}: a package member
 * carries `k:"p"` and its group id in `r`; everything else is untagged. */
export const signedEdgeFor = (
  packageGroupId: number | undefined,
  isFoldedChild: boolean,
): { k: "p"; r: number } | Record<never, never> =>
  packageGroupId !== undefined && !isFoldedChild
    ? { k: "p", r: packageGroupId }
    : {};

/** The package a signed line was booked through, from its edge tag, or
 * undefined for a standalone/child line. */
export const lineGroupId = (line: BookingItem): number | undefined =>
  line.k === "p" ? line.r : undefined;

/** The distinct package group ids an order's lines were booked through. */
export const lineGroupIds = (items: readonly BookingItem[]): Set<number> =>
  new Set(mapNotNullish(lineGroupId)([...items]));

/** Listing ids from lines booked outside a package. */
export const standaloneLineListingIds = (
  items: readonly BookingItem[],
): number[] =>
  items.filter((item) => lineGroupId(item) === undefined).map((item) => item.e);

/** Reconstruct a top-level line's canonical `nodeKey` from its compact edge tag.
 * A package/group member needs its group id (`r`); a line missing that ref (or
 * untagged) is a standalone `listing:<id>`. */
export const lineNodeKey = (line: BookingItem): string => {
  if (line.k === "p" && line.r !== undefined) {
    return packageMemberNodeKey(line.r, line.e);
  }
  if (line.k === "g" && line.r !== undefined) {
    return groupMemberNodeKey(line.r, line.e);
  }
  return listingNodeKey(line.e);
};

const collectNodeKeys = (node: BookingNode, acc: Set<string>): void => {
  acc.add(node.nodeKey);
  for (const child of node.children) collectNodeKeys(child, acc);
};

/** Every `nodeKey` in a tree — top-level nodes and all descendants — as the set
 * a signed line is revalidated against. */
export const treeNodeKeys = (tree: BookingTree): Set<string> => {
  const keys = new Set<string>();
  for (const node of tree.nodes) collectNodeKeys(node, keys);
  return keys;
};

/** Each current PARENT node's required-child listing ids, keyed by its
 * `nodeKey`. A signed line resolving to a parent node must carry SOME of that
 * parent's children — as allocations or as their own lines — because the
 * booking page never folds a parent without a child mix. */
const childIdsByParentNodeKey = (tree: BookingTree): Map<string, number[]> => {
  const byKey = new Map<string, number[]>();
  const walk = (node: BookingNode): void => {
    if (node.children.length > 0) {
      byKey.set(
        node.nodeKey,
        node.children.map((child) => child.listingId),
      );
    }
    for (const child of node.children) walk(child);
  };
  for (const node of tree.nodes) walk(node);
  return byKey;
};

/**
 * Whether any signed line's edge no longer resolves against the current tree.
 *
 * A line whose current node carries required-child edges must have SOME of
 * those children in the order. Otherwise an edge ADDED mid-checkout would book
 * the parent without the add-on the current page requires.
 *
 * The caller fails such an order closed, so it takes the `price_changed` refund
 * rather than books a stale bundle. Per-line price drift is checked separately.
 */
/** Total folded (allocated) quantity per child id across every allocation. */
const allocatedQtyByChild = (
  allocations: readonly ChildAllocation[],
): Map<number, number> => {
  const byChild = new Map<number, number>();
  for (const alloc of allocations) {
    byChild.set(alloc.childId, (byChild.get(alloc.childId) ?? 0) + alloc.qty);
  }
  return byChild;
};

type LineDriftContext = {
  allocatedParentIds: ReadonlySet<number>;
  childIdsByParentKey: ReadonlyMap<string, readonly number[]>;
  foldedQty: ReadonlyMap<number, number>;
  keys: ReadonlySet<string>;
  lineByListing: ReadonlyMap<number, BookingItem>;
};

/** Whether one non-fully-folded line no longer resolves, or has gained a
 * required child that this order does not carry. */
const lineEdgeDrifted = (
  line: BookingItem,
  context: LineDriftContext,
): boolean => {
  // A folded child collapses to one line whose folded units live in
  // `allocations`; skip it ONLY when every unit is folded. A bookable_alone
  // child can carry standalone SURPLUS, which still needs its own validation.
  if ((context.foldedQty.get(line.e) ?? 0) >= line.q) return false;
  const key = lineNodeKey(line);
  if (!context.keys.has(key)) return true;
  const childIds = context.childIdsByParentKey.get(key);
  return (
    childIds !== undefined &&
    !context.allocatedParentIds.has(line.e) &&
    !childIds.some((id) => context.lineByListing.has(id))
  );
};

/** Whether one folded allocation has lost its parent line or parent-child edge. */
const allocationEdgeDrifted = (
  allocation: ChildAllocation,
  keys: ReadonlySet<string>,
  lineByListing: ReadonlyMap<number, BookingItem>,
): boolean => {
  const parent = lineByListing.get(allocation.parentId);
  return (
    parent === undefined ||
    !keys.has(childNodeKey(lineNodeKey(parent), allocation.childId))
  );
};

export const edgeDrifted = (
  tree: BookingTree,
  items: readonly BookingItem[],
  allocations: readonly ChildAllocation[],
): boolean => {
  const keys = treeNodeKeys(tree);
  const childIdsByParentKey = childIdsByParentNodeKey(tree);
  const foldedQty = allocatedQtyByChild(allocations);
  const allocatedParentIds = new Set(allocations.map((a) => a.parentId));
  const lineByListing = new Map(items.map((item) => [item.e, item]));
  const context: LineDriftContext = {
    allocatedParentIds,
    childIdsByParentKey,
    foldedQty,
    keys,
    lineByListing,
  };
  return (
    items.some((line) => lineEdgeDrifted(line, context)) ||
    allocations.some((allocation) =>
      allocationEdgeDrifted(allocation, keys, lineByListing),
    )
  );
};
