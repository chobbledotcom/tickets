/**
 * Shared walk over a child→parents map.
 *
 * A few places build a map from each child listing to the parent listings that
 * point at it, then need the children whose parents pass some rule (add-on
 * classification, package folding, …). This is that shared walk.
 */

/** Collect the child ids whose parent list passes the test. Both the add-on
 * classifier and the package-fold check walk a child→parents map and keep the
 * children whose parents satisfy some rule. */
export const childIdsMatching = <P>(
  parentsByChild: Iterable<readonly [number, P[]]>,
  keep: (parents: P[], childId: number) => boolean,
): Set<number> => {
  const ids = new Set<number>();
  for (const [childId, parents] of parentsByChild) {
    if (keep(parents, childId)) ids.add(childId);
  }
  return ids;
};
