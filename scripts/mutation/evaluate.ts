import { resolve } from "@std/path";
import { withCleanup } from "../cleanup.ts";
import { dim, yellow } from "../precommit/colors.ts";
import { projectRoot } from "../project-root.ts";
import type { StaticAssetBuild } from "../static-assets/session.ts";
import {
  mutantTestEnv,
  runTests,
  type StaticGate,
  type TestRunConfig,
  toStatus,
} from "./execution.ts";
import { applyMutant, generateMutants, type Mutant } from "./generate.ts";
import {
  type MutationPhase,
  measurePhase,
  type PhaseTiming,
  runTestStages,
  type TestStageResult,
} from "./phases.ts";
import { rel, type Status } from "./summary.ts";
import {
  createMutantTestState,
  type MutantTestStateResult,
} from "./test-state.ts";

interface MutantAssetHooks {
  rebuild(): Promise<boolean>;
  restore(): Promise<void>;
}

export interface FileMutationPlan {
  assets: MutantAssetHooks | null;
  directTestFiles: string[];
  file: string;
  mutants: Mutant[];
  original: string;
  rebuildTestState: boolean;
}

export interface MutantEvaluation {
  detectedBy: MutationPhase | null;
  status: Status;
  timings: PhaseTiming[];
}

export interface EvaluationDeps {
  createState: typeof createMutantTestState;
  runTests: typeof runTests;
  write(file: string, content: string): Promise<void>;
}

type FailedTestState = Exclude<MutantTestStateResult, { status: "ready" }>;

const realDeps: EvaluationDeps = {
  createState: createMutantTestState,
  runTests,
  write: Deno.writeTextFile,
};

const detectedByKill = <Phase extends MutationPhase>(
  phase: Phase,
  status: Status,
): Phase | null => (status === "killed" ? phase : null);

const testStatus = (
  phase: "direct-tests" | "integration-tests",
  result: Awaited<ReturnType<typeof runTests>>,
): TestStageResult => {
  const status = toStatus(result.outcome);
  return {
    detectedBy: detectedByKill(phase, status),
    status,
    timings: [{ durationMs: result.durationMs, phase }],
  };
};

const confirmStateMutation = async (
  plan: FileMutationPlan,
  run: TestRunConfig,
  signal: AbortSignal,
  failed: FailedTestState,
  deps: EvaluationDeps,
): Promise<Status> => {
  if (failed.status === "timed-out") return "timed-out";
  await deps.write(plan.file, plan.original);
  const baseline = await deps.createState(run.env, signal);
  if (baseline.status === "timed-out") return "timed-out";
  if (baseline.status === "failed") {
    throw new Error(
      `Mutant test-state build failed (${failed.message}), and ` +
        `the unmutated retry also failed (${baseline.message}).`,
    );
  }
  await baseline.state.cleanup();
  return "killed";
};

const confirmAssetMutation = async (
  plan: FileMutationPlan,
  assets: MutantAssetHooks,
  signal: AbortSignal,
  deps: EvaluationDeps,
): Promise<Status> => {
  if (signal.aborted) return "timed-out";
  await deps.write(plan.file, plan.original);
  if (!(await assets.rebuild())) {
    throw new Error(
      `Browser bundle rebuild also failed for unmutated ${rel(plan.file)}.`,
    );
  }
  return "killed";
};

export const evaluateMutant = async (
  plan: FileMutationPlan,
  mutant: Mutant,
  run: TestRunConfig,
  integrationTestFiles: string[],
  gates: StaticGate[],
  signal: AbortSignal,
  deps: EvaluationDeps = realDeps,
): Promise<MutantEvaluation> => {
  const { assets, directTestFiles, file, original, rebuildTestState } = plan;
  const timings: PhaseTiming[] = [];
  await deps.write(file, applyMutant(original, mutant));
  return withCleanup(async () => {
    try {
      for (const gate of gates) {
        const measured = await measurePhase(gate.phase, () =>
          gate.exit(file, signal),
        );
        timings.push(measured.timing);
        if (measured.value !== 0) {
          return { detectedBy: gate.phase, status: "killed", timings };
        }
      }
      if (assets) {
        const measured = await measurePhase("asset-build", assets.rebuild);
        timings.push(measured.timing);
        if (!measured.value) {
          const status = await confirmAssetMutation(plan, assets, signal, deps);
          return {
            detectedBy: detectedByKill("asset-build", status),
            status,
            timings,
          };
        }
      }
      const stages = await runTestStages(
        directTestFiles,
        integrationTestFiles,
        async (phase, testFiles) => {
          if (phase === "direct-tests") {
            return testStatus(
              phase,
              await deps.runTests(
                {
                  ...run,
                  env: mutantTestEnv(run.env, rebuildTestState),
                  testFiles,
                },
                signal,
              ),
            );
          }
          let state: MutantTestStateResult | null = null;
          let env = mutantTestEnv(run.env, rebuildTestState);
          const stageTimings: PhaseTiming[] = [];
          if (rebuildTestState) {
            const measured = await measurePhase("test-state", () =>
              deps.createState(run.env, signal),
            );
            stageTimings.push(measured.timing);
            state = measured.value;
            if (state.status !== "ready") {
              const status = await confirmStateMutation(
                plan,
                run,
                signal,
                state,
                deps,
              );
              return {
                detectedBy: detectedByKill("test-state", status),
                status,
                timings: stageTimings,
              };
            }
            env = state.state.env;
          }
          try {
            const tested = testStatus(
              phase,
              await deps.runTests({ ...run, env, testFiles }, signal),
            );
            return {
              detectedBy: tested.detectedBy,
              status: tested.status,
              timings: [...stageTimings, ...tested.timings],
            };
          } finally {
            if (state?.status === "ready") await state.state.cleanup();
          }
        },
      );
      timings.push(...stages.timings);
      return {
        detectedBy: stages.detectedBy,
        status: stages.status,
        timings,
      };
    } catch (error) {
      if (signal.aborted) {
        return { detectedBy: null, status: "timed-out", timings };
      }
      throw error;
    }
  }, [() => deps.write(file, original), ...(assets ? [assets.restore] : [])]);
};

const logFilePlan = (plan: FileMutationPlan, affectedCount: number): void => {
  if (plan.mutants.length === 0) {
    console.log(yellow(`  no mutable operators in ${rel(plan.file)}`));
    return;
  }
  const notes = [
    affectedCount > 0 ? `rebuilding ${affectedCount} bundle(s) per mutant` : "",
    `${plan.directTestFiles.length} direct test(s) first`,
    plan.rebuildTestState ? "shared mutant test state for integration" : "",
  ].filter((entry) => entry !== "");
  const note = dim(` (${notes.join("; ")})`);
  console.log(
    dim(`  ${rel(plan.file)}: ${plan.mutants.length} mutants`) + note,
  );
};

export const createFilePlan = async (
  rebuilder: StaticAssetBuild | null,
  stateBuilderFiles: Set<string> | null,
  exhaustive: boolean,
  file: string,
  directTestFiles: string[],
): Promise<FileMutationPlan> => {
  const original = await Deno.readTextFile(file);
  const affected = rebuilder ? rebuilder.affected(file) : [];
  const assets =
    rebuilder && affected.length > 0
      ? {
          rebuild: () => rebuilder.rebuild(affected),
          restore: () => rebuilder.restore(affected),
        }
      : null;
  const plan = {
    assets,
    directTestFiles,
    file,
    mutants: generateMutants(original, file, exhaustive),
    original,
    rebuildTestState:
      stateBuilderFiles?.has(resolve(projectRoot, file)) ?? false,
  };
  logFilePlan(plan, affected.length);
  return plan;
};
