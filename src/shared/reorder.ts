/** Pure helper behind every "move up / move down" admin control. */

/**
 * Given an ordered list of keys and one target key, return the target paired
 * with the neighbour it should trade places with when nudged one step `dir`,
 * or null when it can't move — the target isn't in the list, or it's already
 * at the end it's heading toward. Keeping the off-by-one here means every
 * ordered-list surface reorders the same way.
 */
export const planReorder = <K>(
  orderedKeys: readonly K[],
  target: K,
  dir: "up" | "down",
): readonly [K, K] | null => {
  const idx = orderedKeys.indexOf(target);
  if (idx === -1) return null;
  const neighbor = orderedKeys[idx + (dir === "up" ? -1 : 1)];
  return neighbor === undefined ? null : [target, neighbor];
};
