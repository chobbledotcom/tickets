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

/**
 * The `DENO_JOBS` value a precommit run should use: an explicit operator-set
 * value always wins; otherwise the capped worker count for CI vs local.
 * Returns `undefined` when the caller should not change the env (the operator
 * set `DENO_JOBS` themselves — `main` checks for this and skips).
 */
export const resolveDenoJobs = (
  hardwareConcurrency: number,
  ci: boolean,
  currentDenoJobs: string | undefined,
): number | undefined => {
  if (currentDenoJobs !== undefined) return;
  return precommitWorkerCount(hardwareConcurrency, ci);
};
