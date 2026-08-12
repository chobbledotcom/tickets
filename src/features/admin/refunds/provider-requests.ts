import { chunk } from "#fp";

/** Max provider refund subrequests in flight at once. */
export const PROVIDER_REFUND_CONCURRENCY = 5;

/** Run one bounded group at a time while each group's work runs together. */
export const mapProviderRequests = async <TItem, TResult>(
  items: readonly TItem[],
  run: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> => {
  const results: TResult[] = [];
  for (const group of chunk(PROVIDER_REFUND_CONCURRENCY)([...items])) {
    results.push(...(await Promise.all(group.map(run))));
  }
  return results;
};
