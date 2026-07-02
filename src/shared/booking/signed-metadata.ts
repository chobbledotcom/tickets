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
export const edgeDrifted = (
  tree: BookingTree,
  items: readonly BookingItem[],
  allocations: readonly ChildAllocation[],
): boolean => {
  const keys = treeNodeKeys(tree);
  const childIdsByParentKey = childIdsByParentNodeKey(tree);
  const foldedChildIds = new Set(allocations.map((a) => a.childId));
  const allocatedParentIds = new Set(allocations.map((a) => a.parentId));
  const lineByListing = new Map(items.map((item) => [item.e, item]));
  for (const line of items) {
    if (foldedChildIds.has(line.e)) continue;
    const key = lineNodeKey(line);
    if (!keys.has(key)) return true;
    const childIds = childIdsByParentKey.get(key);
    if (
      childIds &&
      !allocatedParentIds.has(line.e) &&
      !childIds.some((id) => lineByListing.has(id))
    ) {
      return true;
    }
  }
  for (const alloc of allocations) {
    const parent = lineByListing.get(alloc.parentId);
    if (!parent) return true;
    if (!keys.has(childNodeKey(lineNodeKey(parent), alloc.childId)))
      return true;
  }
  return false;
};
