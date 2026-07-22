import { resolve } from "@std/path";
import { withCleanup } from "#scripts/cleanup.ts";
import { dim, yellow } from "#scripts/precommit/colors.ts";
import { projectRoot } from "#scripts/project-root.ts";
import type { StaticAssetBuild } from "#scripts/static-assets/session.ts";
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

interface MutantRunContext {
  deps: EvaluationDeps;
  plan: FileMutationPlan;
  run: TestRunConfig;
  signal: AbortSignal;
}

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
  { deps, plan, run, signal }: MutantRunContext,
  failed: FailedTestState,
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
  { deps, plan, signal }: MutantRunContext,
  assets: MutantAssetHooks,
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

const runStaticGates = async (
  { plan, signal }: MutantRunContext,
  gates: StaticGate[],
  timings: PhaseTiming[],
): Promise<MutantEvaluation | null> => {
  for (const gate of gates) {
    const measured = await measurePhase(gate.phase, () =>
      gate.exit(plan.file, signal),
    );
    timings.push(measured.timing);
    if (measured.value !== 0) {
      return { detectedBy: gate.phase, status: "killed", timings };
    }
  }
  return null;
};

const runTestFiles = async (
  { deps, run, signal }: MutantRunContext,
  phase: "direct-tests" | "integration-tests",
  testFiles: string[],
  env: Record<string, string>,
): Promise<TestStageResult> =>
  testStatus(phase, await deps.runTests({ ...run, env, testFiles }, signal));

const runIntegrationTestStage = async (
  context: MutantRunContext,
  testFiles: string[],
): Promise<TestStageResult> => {
  const { deps, plan, run, signal } = context;
  let state: MutantTestStateResult | null = null;
  let env = mutantTestEnv(run.env, plan.rebuildTestState);
  const timings: PhaseTiming[] = [];
  if (plan.rebuildTestState) {
    const measured = await measurePhase("test-state", () =>
      deps.createState(run.env, signal),
    );
    timings.push(measured.timing);
    state = measured.value;
    if (state.status !== "ready") {
      const status = await confirmStateMutation(context, state);
      return {
        detectedBy: detectedByKill("test-state", status),
        status,
        timings,
      };
    }
    env = state.state.env;
  }
  try {
    const tested = await runTestFiles(
      context,
      "integration-tests",
      testFiles,
      env,
    );
    return {
      detectedBy: tested.detectedBy,
      status: tested.status,
      timings: [...timings, ...tested.timings],
    };
  } finally {
    if (state?.status === "ready") await state.state.cleanup();
  }
};

const runTestStage =
  (context: MutantRunContext) =>
  async (
    phase: "direct-tests" | "integration-tests",
    testFiles: string[],
  ): Promise<TestStageResult> => {
    if (phase === "direct-tests") {
      return runTestFiles(
        context,
        phase,
        testFiles,
        mutantTestEnv(context.run.env, context.plan.rebuildTestState),
      );
    }
    return runIntegrationTestStage(context, testFiles);
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
  await deps.write(plan.file, applyMutant(plan.original, mutant));
  const context = { deps, plan, run, signal };
  const timings: PhaseTiming[] = [];
  return withCleanup(async () => {
    try {
      const gateResult = await runStaticGates(context, gates, timings);
      if (gateResult) return gateResult;
      if (plan.assets) {
        const measured = await measurePhase("asset-build", plan.assets.rebuild);
        timings.push(measured.timing);
        if (!measured.value) {
          const status = await confirmAssetMutation(context, plan.assets);
          return {
            detectedBy: detectedByKill("asset-build", status),
            status,
            timings,
          };
        }
      }
      const stages = await runTestStages(
        plan.directTestFiles,
        integrationTestFiles,
        runTestStage(context),
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
  }, [
    () => deps.write(plan.file, plan.original),
    ...(plan.assets ? [plan.assets.restore] : []),
  ]);
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
