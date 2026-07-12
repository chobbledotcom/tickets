import { sumByKey } from "#fp";
import { effectivePrice } from "#shared/booking/price-tree.ts";
import {
  type BookingNode,
  type BookingTree,
  nodeFixedQuantity,
} from "#shared/booking/tree.ts";
import type { CheckoutItem } from "#shared/payments.ts";

/**
 * Build an order's checkout lines from the booking tree: **one line per booked
 * top-level PATH** — a package member node's line carries its package's group
 * id; a standalone node's line carries none — plus one line per folded child
 * listing. A listing booked through two overlapping packages (or a package
 * plus its own standalone row) therefore gets one line per path, each priced
 * by ITS OWN rule and each becoming its own booking row, so overlapping
 * bundles never restrict what can be booked. Pure: the caller resolves the
 * tree, quantities, and prices.
 */

/** The package a member node books through, or undefined for any other node. */
const nodePackageGroupId = (node: BookingNode): number | undefined =>
  node.edgeRef.kind === "group_member" && node.quantityRule.kind === "FIXED"
    ? node.edgeRef.groupId
    : undefined;

/** Resolve each top-level node's booked quantity by nodeKey: a package member
 * node books its fixed per-package quantity × its package's chosen count; a
 * standalone node books its listing's own chosen quantity. The per-PATH
 * counterpart of the aggregate quantities map. */
export const nodeQuantitiesFor = (
  tree: BookingTree,
  standaloneQuantities: ReadonlyMap<number, number>,
  packageCounts: ReadonlyMap<number, number>,
): Map<string, number> => {
  const byNodeKey = new Map<string, number>();
  for (const node of tree.nodes) {
    const packageGroupId = nodePackageGroupId(node);
    byNodeKey.set(
      node.nodeKey,
      packageGroupId === undefined
        ? (standaloneQuantities.get(node.listingId) ?? 0)
        : nodeFixedQuantity(node) * (packageCounts.get(packageGroupId) ?? 0),
    );
  }
  return byNodeKey;
};

/** Sum the per-node quantities into the per-listing aggregate every
 * listing-keyed consumer (capacity checks, the child fold, questions) reads —
 * a listing booked through two paths counts all its paths' units. Zero-total
 * listings are omitted, matching the parsed-quantities convention. */
export const aggregateNodeQuantities = (
  tree: BookingTree,
  nodeQuantities: ReadonlyMap<string, number>,
): Map<number, number> => {
  const booked = tree.nodes
    .map((node) => ({
      listingId: node.listingId,
      quantity: nodeQuantities.get(node.nodeKey) ?? 0,
    }))
    // Zero-total listings are omitted, matching the parsed-quantities convention.
    .filter((line) => line.quantity > 0);
  return sumByKey<{ listingId: number; quantity: number }, number>(
    (line) => line.listingId,
    (line) => line.quantity,
  )(booked);
};

/** One child node per child listing id (child facets are derived from the
 * listing alone, so the first node for an id stands for them all). */
const childNodesByListingId = (tree: BookingTree): Map<number, BookingNode> => {
  const byId = new Map<number, BookingNode>();
  for (const node of tree.nodes) {
    for (const child of node.children) {
      if (!byId.has(child.listingId)) byId.set(child.listingId, child);
    }
  }
  return byId;
};

/** Build the order's checkout lines. `nodeQuantities` carries each top-level
 * node's booked quantity by nodeKey; `foldedQuantities` is the fold's
 * per-listing aggregate (top-level paths plus folded children), so each child
 * line's quantity is whatever the other lines don't cover. A CHILD listing
 * keeps ONE line for all its units — folded plus any of its own standalone row
 * (a `bookable_alone` child beside its parent) — because the create paths
 * split a child's line by the fold's allocations, and would mistake a second
 * same-listing line for more folded units. One line loses nothing: a child is
 * never a package member, so both its paths price by the same rule.
 * `customPrices` carries pay-more inputs and QR overrides by listing id (a
 * pay-more listing is never a package member, so one price per listing id
 * stays sound). */
export const buildOrderLines = (
  tree: BookingTree,
  nodeQuantities: ReadonlyMap<string, number>,
  foldedQuantities: ReadonlyMap<number, number>,
  customPrices: ReadonlyMap<number, number>,
  dayCount: number,
): CheckoutItem[] => {
  const childById = childNodesByListingId(tree);
  const pathLines = tree.nodes.flatMap((node): CheckoutItem[] => {
    const quantity = nodeQuantities.get(node.nodeKey) ?? 0;
    if (quantity <= 0 || childById.has(node.listingId)) return [];
    const packageGroupId = nodePackageGroupId(node);
    return [
      {
        listingId: node.listingId,
        name: node.listing.name,
        ...(packageGroupId === undefined ? {} : { packageGroupId }),
        quantity,
        slug: node.listing.slug,
        unitPrice: effectivePrice(
          node.priceRule,
          node.listing,
          customPrices,
          dayCount,
        ),
      },
    ];
  });
  // Whatever the fold booked beyond the emitted lines is child units.
  const emittedByListingId = new Map<number, number>();
  for (const line of pathLines) {
    emittedByListingId.set(
      line.listingId,
      (emittedByListingId.get(line.listingId) ?? 0) + line.quantity,
    );
  }
  const childLines = [...foldedQuantities].flatMap(
    ([listingId, total]): CheckoutItem[] => {
      const quantity = total - (emittedByListingId.get(listingId) ?? 0);
      if (quantity <= 0) return [];
      // Every folded listing beyond the emitted lines is some parent's
      // child, so its node is always present here.
      const child = childById.get(listingId)!;
      return [
        {
          listingId,
          name: child.listing.name,
          quantity,
          slug: child.listing.slug,
          unitPrice: effectivePrice(
            child.priceRule,
            child.listing,
            customPrices,
            dayCount,
          ),
        },
      ];
    },
  );
  return [...pathLines, ...childLines];
};
