/**
 * One shared read for browser storage: the array a previous page visit
 * stored, kept only where its entries still pass.
 */

/** Read an array back out of stored JSON. Keep only the entries that
 * still pass. A corrupt value throws — the caller decides what that reads
 * as (absent, discarded, memory-only). */
export const storedArray = <T>(
  raw: string | null,
  keep: (entry: unknown) => entry is T,
): T[] => {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter(keep) : [];
};
