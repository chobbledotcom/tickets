/** Read a worker count from an environment value, falling back when invalid. */
export const parseWorkerCount = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const jobs = Number(value);
  return Number.isSafeInteger(jobs) && jobs > 0 ? jobs : fallback;
};

/**
 * Test worker count for a precommit run. In CI, use every available thread.
 * Locally, leave headroom for the editor and other foreground work: half the
 * threads minus one (never less than one).
 */
const precommitWorkerCount = (
  hardwareConcurrency: number,
  ci: boolean,
): number =>
  ci
    ? hardwareConcurrency
    : Math.max(1, Math.floor(hardwareConcurrency / 2) - 1);

/**
 * The `DENO_JOBS` value a precommit run should use. A valid positive whole
 * number wins; otherwise use the capped worker count for CI or local work.
 */
export const resolveDenoJobs = (
  hardwareConcurrency: number,
  ci: boolean,
  currentDenoJobs: string | undefined,
): number =>
  parseWorkerCount(
    currentDenoJobs,
    precommitWorkerCount(hardwareConcurrency, ci),
  );
