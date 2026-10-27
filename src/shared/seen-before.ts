/**
 * Duplicate spotting for one pass over a list.
 */

/** Remembers every key it is given. Returns false the first time a key
 * arrives, and true when the same key comes back. A loop can then catch
 * repeats (a name referenced twice, a duplicate ignore-list entry) the
 * moment they appear. It needs no Set of its own. */
export const seenBefore = (): ((key: string) => boolean) => {
  const seen = new Set<string>();
  return (key: string): boolean => {
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  };
};
