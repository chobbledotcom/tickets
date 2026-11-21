/** Shared fixtures for the mutant evaluation tests. */

import {
  type EvaluationDeps,
  evaluateMutantTests,
  type FileMutationPlan,
  type MutantEvaluation,
} from "#scripts/mutation/evaluate.ts";
import type { Mutant } from "#scripts/mutation/generate.ts";
import type { PlannedRun } from "#scripts/mutation/plan.ts";
import { TEST_STATE_DIR_ENV } from "#test-utils/test-state-env.ts";

export const mutant: Mutant = {
  anchor: "flag",
  column: 1,
  end: 4,
  line: 1,
  newOperator: "false",
  operator: "true",
  start: 0,
};

export const plan = (
  changes: Partial<FileMutationPlan> = {},
): FileMutationPlan => ({
  assets: null,
  directTestFiles: ["test/shared/example.test.ts"],
  file: "src/shared/example.ts",
  mutants: [mutant],
  original: "true",
  rebuildTestState: true,
  ...changes,
});

export const setup = () => {
  const cleaned: string[] = [];
  const runs: Array<{ env: Record<string, string>; files: string[] }> = [];
  const signals: AbortSignal[] = [];
  const writes: string[] = [];
  const deps: EvaluationDeps = {
    createState: (_env) =>
      Promise.resolve({
        state: {
          cleanup: () => {
            cleaned.push("state");
            return Promise.resolve();
          },
          env: { [TEST_STATE_DIR_ENV]: "/mutant-state" },
        },
        status: "ready",
      }),
    runTests: ({ env, testFiles }, signal) => {
      runs.push({ env, files: testFiles });
      signals.push(signal);
      return Promise.resolve({ durationMs: 1, outcome: "passed" });
    },
    write: (_file, content) => {
      writes.push(content);
      return Promise.resolve();
    },
  };
  return { cleaned, deps, runs, signals, writes };
};

export const runConfig = {
  batchJobs: 1,
  env: { BASE: "yes", [TEST_STATE_DIR_ENV]: "/baseline-state" },
  limitMs: 60_000,
  testFiles: [],
};

export const evaluateIntegration = (
  state: ReturnType<typeof setup>,
): Promise<MutantEvaluation> =>
  evaluateMutantTests(
    plan(),
    mutant,
    runConfig,
    ["test/integration/example.test.ts"],
    new AbortController().signal,
    [],
    state.deps,
  );

/** Two planned direct runs: the mapped tests, then one slow file. */
export const plannedTwoRuns = (
  testFiles: readonly string[],
): readonly PlannedRun[] => [
  { files: testFiles, ms: 100 },
  { files: ["test/shared/slow.test.ts"], ms: 5_000 },
];

export const evaluatePlanned = (
  state: ReturnType<typeof setup>,
  planned: (testFiles: readonly string[]) => readonly PlannedRun[],
  integrationFiles: string[] = [],
): Promise<MutantEvaluation> =>
  evaluateMutantTests(
    plan({ rebuildTestState: false }),
    mutant,
    { ...runConfig, limitMs: null, plan: planned },
    integrationFiles,
    new AbortController().signal,
    [],
    state.deps,
  );
