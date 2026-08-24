import type { BookingNode, BookingTree } from "#booking/tree.ts";

/**
 * Every node in the tree with the deepest children first and the top-level
 * nodes last. Writing a listing-id-keyed map in this order lets a top-level
 * node have the final say over a same-id child, because the top-level node is
 * written after (and so overwrites) its descendants — the "top-level wins"
 * rule the price-rule map relies on. Callers that don't care about order
 * (unique keys) can walk it just to reach every node once.
 */
export const nodesDeepestFirst = (tree: BookingTree): BookingNode[] => {
  const byDepth: BookingNode[][] = [];
  const collect = (nodes: readonly BookingNode[], depth: number): void => {
    const atDepth = byDepth[depth] ?? [];
    byDepth[depth] = atDepth;
    atDepth.push(...nodes);
    for (const node of nodes) collect(node.children, depth + 1);
  };
  collect(tree.nodes, 0);
  return byDepth.reverse().flat();
};
