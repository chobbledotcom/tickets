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
 * The caller can also name a different fallback, as `precommitDenoJobs` does
 * when it caps the coverage gate's default.
 */
export const resolveDenoJobs = (
  hardwareConcurrency: number,
  ci: boolean,
  currentDenoJobs: string | undefined,
  fallback: number = precommitWorkerCount(hardwareConcurrency, ci),
): number => parseWorkerCount(currentDenoJobs, fallback);

/**
 * Worker count for the coverage gate: every test worker's V8 coverage
 * buffers and isolate state grow with the files its group holds, and the
 * workers run concurrently, so the gate's total memory is roughly
 * workers × per-isolate peak. Four keeps that sum inside a standard CI
 * runner's budget (the group count rises with the file count, so each
 * isolate stays small). A valid explicit `DENO_JOBS` wins; blank and
 * invalid values fall back to the capped count.
 */
export const COVERAGE_WORKER_CAP = 4;

export const coverageDenoJobs = (
  currentDenoJobs: string | undefined,
  hardwareConcurrency: number,
): number | undefined =>
  parseWorkerCount(currentDenoJobs, 0) === 0
    ? Math.min(hardwareConcurrency, COVERAGE_WORKER_CAP)
    : undefined;

/** The DENO_JOBS value a precommit run should use. The run's test step is the
 *  coverage gate, so the default also takes the gate's worker cap. A valid
 *  explicit DENO_JOBS wins, and an invalid one falls back to the capped
 *  default. */
export const precommitDenoJobs = (
  hardwareConcurrency: number,
  ci: boolean,
  currentDenoJobs: string | undefined,
): number => {
  if (currentDenoJobs !== undefined) {
    const explicit = parseWorkerCount(currentDenoJobs, 0);
    if (explicit > 0) return explicit;
  }
  return resolveDenoJobs(
    hardwareConcurrency,
    ci,
    undefined,
    Math.min(
      precommitWorkerCount(hardwareConcurrency, ci),
      COVERAGE_WORKER_CAP,
    ),
  );
};
