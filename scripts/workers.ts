/** Read a worker count from an environment value, falling back when invalid. */
export const parseWorkerCount = (
  value: string | undefined,
  fallback: number,
): number => {
  const jobs = Number(value);
  return Number.isInteger(jobs) && jobs > 0 ? jobs : fallback;
};

/**
 * Test worker count for a precommit run. In CI, use every available thread.
 * Locally, leave headroom for the editor and other foreground work: half the
 * threads minus one (never less than one). Callers should skip setting
 * `DENO_JOBS` when the operator has already set it, so an explicit override
 * always wins.
 */
export const precommitWorkerCount = (
  hardwareConcurrency: number,
  ci: boolean,
): number =>
  ci
    ? hardwareConcurrency
    : Math.max(1, Math.floor(hardwareConcurrency / 2) - 1);
