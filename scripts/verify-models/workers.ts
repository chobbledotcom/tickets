// The largest check holds about 5 GiB. The budget leaves room above that.
const WORKER_MEMORY_BYTES = 6 * 1024 ** 3;

/** The number of checks that can run together on this machine. One check uses
 *  more than one core. The count never falls below two. */
export const workerCount = (cores: number, availableBytes: number): number =>
  Math.max(
    2,
    Math.min(
      Math.floor(cores / 2),
      Math.floor(availableBytes / WORKER_MEMORY_BYTES),
    ),
  );
