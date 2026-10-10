/** A per-group map, written the way the callers build one: only capped
 *  groups appear, so absence means "this group has no cap". */
export const byGroup = (
  entries: Record<number, number>,
): ReadonlyMap<number, number> =>
  new Map(Object.entries(entries).map(([id, spots]) => [Number(id), spots]));
