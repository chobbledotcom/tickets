/**
 * Run `step` on every item, giving each worker one item at a time, so at most
 * one item per worker runs at once. The results keep the items' order.
 */
export const inParallel = async <T, W, R>(
  items: readonly T[],
  workers: readonly W[],
  step: (item: T, index: number, worker: W) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  // One shared queue: each worker takes the next item until none are left.
  const queue = items.entries();
  const work = async (worker: W): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await step(item, index, worker);
    }
  };
  await Promise.all(workers.map(work));
  return results;
};
