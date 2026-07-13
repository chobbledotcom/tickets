/**
 * Duplicate spotting for one pass over a list.
 */

/** Remembers every key it is given. Returns false the first time a key
 * arrives and true when the same key comes back — so a loop can catch
 * repeats (a name referenced twice, a duplicate ignore-list entry) the
 * moment they appear, without managing its own Set. */
export const seenBefore = (): ((key: string) => boolean) => {
  const seen = new Set<string>();
  return (key: string): boolean => {
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
};
