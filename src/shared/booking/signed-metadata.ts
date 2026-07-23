import { mapNotNullish } from "#fp";
import {
  type BookingNode,
  type BookingTree,
  childNodeKey,
  groupMemberNodeKey,
  listingNodeKey,
  packageMemberNodeKey,
} from "#shared/booking/tree.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import type { BookingItem } from "#shared/payments.ts";

/**
 * Signed-metadata edge provenance.
 *
 * A signed line tags each top-level line with a compact edge so the webhook can
 * reconstruct the line's canonical {@link BookingTree} `nodeKey` and re-check it
 * still resolves against current config — catching an operator who removed or
 * swapped an edge (a package member, a required child) while the buyer's checkout
 * was open. The tag is deliberately tiny (`k` one char, `r` a group id) so
 * nested-package metadata still fits the provider entry/value caps.
 *
 * Only a *package member* top-level line needs a tag: a standalone (or regular
 * group) line reconstructs to `listing:<id>` and a folded child is carried in the
 * `allocations` map, not tagged here (a child reached under two parents collapses
 * to one line, so its per-edge identity lives in the allocations). The `"g"`
 * (regular group member) code is decoded for completeness but not emitted — a
 * regular group books its members as standalone listing lines.
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
 * Whether any signed line's edge no longer resolves against the current tree — a
 * package member that is no longer a member, or a folded child whose parent edge
 * was removed/swapped mid-checkout. Each top-level (non-folded) line must map to
 * a current `nodeKey`; a line whose current node carries required-child edges
 * must have SOME of those children in the order — an allocation for the parent
 * or a child's own line — else an edge ADDED mid-checkout would book the parent
 * without the add-on the current page requires; each allocation's child must
 * resolve under its parent line's reconstructed `nodeKey` (and that parent line
 * must itself be present). The caller fails such an order closed so it takes
 * the `price_changed` refund rather than booking a stale bundle. Per-line price
 * drift is checked separately.
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
