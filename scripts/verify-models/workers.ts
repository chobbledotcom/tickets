// The largest check holds about 5 GiB. The budget leaves room above that.
const WORKER_MEMORY_BYTES = 6 * 1024 ** 3;

/** Use half the cores and at most one process per 6 GiB of free memory. */
export const workerCount = (cores: number, availableBytes: number): number => {
  const memoryPlaces = Math.floor(availableBytes / WORKER_MEMORY_BYTES);
  if (memoryPlaces < 1) {
    throw new Error("Model checks require at least 6 GiB of free memory.");
  }
  return Math.min(Math.max(1, Math.floor(cores / 2)), memoryPlaces);
};
