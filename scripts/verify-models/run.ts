import {
  CHECK_PHASES,
  type CheckerResult,
  requireCounterexample,
} from "#scripts/verify-models/check.ts";
import type { ModelCheck } from "#scripts/verify-models/jobs.ts";

type CheckRunner = (check: ModelCheck) => Promise<CheckerResult>;

const checkOne = async (check: ModelCheck, run: CheckRunner): Promise<void> => {
  const name =
    check.kind === "proof"
      ? CHECK_PHASES[check.phase].name
      : `${check.name} counterexample`;
  const label = `${check.module}: ${name}`;
  console.log(`Check ${label}.`);
  const started = performance.now();
  const result = await run(check);
  if (check.kind === "control") {
    requireCounterexample(result, check.name, check.directory);
  } else if (!result.success) {
    throw new Error(
      `${check.module} proof failed. Read ${check.directory}.\n${result.output}`,
    );
  }
  console.log(
    `Passed ${label} (${((performance.now() - started) / 1000).toFixed(3)} seconds).`,
  );
};

/** Stop new work on failure and await both active processes before the caller returns. */
export const runChecks = async (
  checks: readonly ModelCheck[],
  run: CheckRunner,
): Promise<void> => {
  const pending = checks.values();
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const next = pending.next();
      if (next.done) return;
      try {
        await checkOne(next.value, run);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  // Two JVMs bound memory use on the shared machine. Never start the whole queue.
  const results = await Promise.allSettled([worker(), worker()]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
};
