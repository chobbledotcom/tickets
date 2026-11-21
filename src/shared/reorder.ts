/** Pure helper behind every admin reorder control: the arrows and a drop. */

/** Where a moved item lands beside its anchor. */
export type MovePlace = "before" | "after";

/**
 * The new order after `target` moves to just before or just after `anchor`.
 * Null when either key is not in the list, or when the anchor is the target.
 * An arrow names the neighbour above or below, and a drop names the row it
 * lands next to, so every reorder takes this one path.
 */
export const moveKey = <K>(
  order: readonly K[],
  target: K,
  place: MovePlace,
  anchor: K,
): readonly K[] | null => {
  if (target === anchor || !order.includes(target)) return null;
  const rest = order.filter((key) => key !== target);
  const anchorIndex = rest.indexOf(anchor);
  if (anchorIndex === -1) return null;
  const at = place === "before" ? anchorIndex : anchorIndex + 1;
  return [...rest.slice(0, at), target, ...rest.slice(at)];
};
