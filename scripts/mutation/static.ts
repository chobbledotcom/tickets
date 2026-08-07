import { dirname, join, relative, resolve, SEPARATOR } from "@std/path";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";
import { projectRoot } from "#scripts/project-root.ts";
import type { FileMutationPlan, MutantEvaluation } from "./evaluate.ts";
import type { StaticGate } from "./execution.ts";
import { applyMutant, type Mutant } from "./generate.ts";
import { copyMutationSnapshot } from "./isolation-state.ts";
import {
  type MutationPhase,
  measurePhase,
  type PhaseTiming,
} from "./phases.ts";

const MAX_STATIC_JOBS = 4;
const PARALLEL_STATIC_MIN_MUTANTS = 3;

export interface StaticEvaluation extends MutantEvaluation {
  deadlineAt: number;
  mutant: Mutant;
}

export interface StaticRunConfig {
  abortSignal: AbortSignal;
  jobs: number;
  perMutantTimeout: number;
  root: string;
  workerParent: string;
}

export interface StaticDeps {
  copy(from: string, to: string): Promise<void>;
  now(): number;
  remove(path: string): Promise<void>;
  write(file: string, content: string): Promise<void>;
}

const realDeps: StaticDeps = {
  copy: copyMutationSnapshot,
  now: performance.now.bind(performance),
  remove: (path) => Deno.remove(path, { recursive: true }),
  write: Deno.writeTextFile,
};

export const defaultStaticJobs = (): number => {
  const configured = Number(Deno.env.get("MUTATION_STATIC_JOBS"));
  const cpuJobs = Math.max(1, navigator.hardwareConcurrency - 1);
  const requested =
    Number.isInteger(configured) && configured > 0 ? configured : cpuJobs;
  return Math.min(MAX_STATIC_JOBS, requested);
};

const mappedFile = (root: string, workspace: string, file: string): string => {
  const path = relative(root, resolve(root, file));
  if (path === ".." || path.startsWith(`..${SEPARATOR}`)) {
    throw new Error(`Mutation target is outside its workspace: ${file}`);
  }
  return join(workspace, path);
};

const staticEvaluation = (
  context: StaticContext,
  mutant: Mutant,
  status: MutantEvaluation["status"],
  detectedBy: MutationPhase | null,
  timings: PhaseTiming[],
  startedAt: number,
): StaticEvaluation => ({
  deadlineAt: startedAt + context.config.perMutantTimeout,
  detectedBy,
  mutant,
  status,
  timings,
});

const evaluateOne = async (
  context: StaticContext,
  mutant: Mutant,
  workspace: string,
): Promise<StaticEvaluation> => {
  const { config, deps, gates, plan } = context;
  const startedAt = deps.now();
  const timings: PhaseTiming[] = [];
  const signal = AbortSignal.any([
    config.abortSignal,
    AbortSignal.timeout(config.perMutantTimeout),
  ]);
  const file = mappedFile(config.root, workspace, plan.file);
  try {
    await deps.write(file, applyMutant(plan.original, mutant));
    for (const gate of gates) {
      const measured = await measurePhase(
        gate.phase,
        () => gate.exit(file, workspace, signal),
        deps.now,
      );
      timings.push(measured.timing);
      if (measured.value !== 0) {
        return staticEvaluation(
          context,
          mutant,
          "killed",
          gate.phase,
          timings,
          startedAt,
        );
      }
    }
    return staticEvaluation(
      context,
      mutant,
      "survived",
      null,
      timings,
      startedAt,
    );
  } catch (error) {
    if (signal.aborted) {
      return staticEvaluation(
        context,
        mutant,
        "timed-out",
        null,
        timings,
        startedAt,
      );
    }
    throw error;
  }
};

const serialStatic = async (
  context: StaticContext,
): Promise<StaticEvaluation[]> => {
  const { config, deps, plan } = context;
  const cursor = createCursor(plan.mutants.length);
  try {
    await runAvailable(context, cursor, config.root);
    return completedResults(cursor);
  } finally {
    await deps.write(plan.file, plan.original);
  }
};

interface StaticCursor {
  next: number;
  results: Array<StaticEvaluation | undefined>;
}

interface StaticContext {
  config: StaticRunConfig;
  deps: StaticDeps;
  gates: StaticGate[];
  plan: FileMutationPlan;
}

const createCursor = (length: number): StaticCursor => ({
  next: 0,
  results: Array.from({ length }),
});

const completedResults = (cursor: StaticCursor): StaticEvaluation[] =>
  cursor.results.filter(
    (result): result is StaticEvaluation => result !== undefined,
  );

const runAvailable = async (
  context: StaticContext,
  cursor: StaticCursor,
  workspace: string,
): Promise<void> => {
  while (!context.config.abortSignal.aborted) {
    const index = cursor.next++;
    const mutant = context.plan.mutants[index];
    if (!mutant) return;
    cursor.results[index] = await evaluateOne(context, mutant, workspace);
  }
};

const runWorker = async (
  context: StaticContext,
  cursor: StaticCursor,
  workspace: string,
  stop: AbortController,
): Promise<void> => {
  try {
    await runAvailable(context, cursor, workspace);
  } catch (error) {
    stop.abort(error);
    throw error;
  }
};

const removeWorkspaces = async (
  workspaces: string[],
  deps: StaticDeps,
): Promise<void> => {
  await Promise.all(
    workspaces.map((workspace) =>
      deps.remove(workspace).catch(rethrowUnlessNotFound),
    ),
  );
};

const waitForAll = async (work: Promise<void>[]): Promise<void> => {
  const settled = await Promise.allSettled(work);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
};

export const evaluateStaticMutants = async (
  plan: FileMutationPlan,
  gates: StaticGate[],
  config: StaticRunConfig,
  deps: StaticDeps = realDeps,
): Promise<StaticEvaluation[]> => {
  const context = { config, deps, gates, plan };
  const jobs = Math.min(MAX_STATIC_JOBS, config.jobs, plan.mutants.length);
  if (jobs <= 1 || plan.mutants.length < PARALLEL_STATIC_MIN_MUTANTS) {
    return serialStatic(context);
  }

  const workspaces = Array.from({ length: jobs }, (_, index) =>
    join(config.workerParent, `static-${index + 1}`),
  );
  try {
    await waitForAll(
      workspaces.map((workspace) => deps.copy(config.root, workspace)),
    );
    const stop = new AbortController();
    const workerConfig = {
      ...config,
      abortSignal: AbortSignal.any([config.abortSignal, stop.signal]),
    };
    const workerContext = { ...context, config: workerConfig };
    const cursor = createCursor(plan.mutants.length);
    await waitForAll(
      workspaces.map((workspace) =>
        runWorker(workerContext, cursor, workspace, stop),
      ),
    );
    return completedResults(cursor);
  } finally {
    await removeWorkspaces(workspaces, deps);
  }
};

export const staticWorkerParent = (): string => dirname(projectRoot);
