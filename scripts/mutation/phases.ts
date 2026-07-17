import type { Status } from "./summary.ts";

export type MutationPhase =
  | "lint"
  | "type-check"
  | "asset-build"
  | "direct-tests"
  | "test-state"
  | "integration-tests";

export interface PhaseTiming {
  durationMs: number;
  phase: MutationPhase;
}

export interface Measured<T> {
  timing: PhaseTiming;
  value: T;
}

export const measurePhase = async <T>(
  phase: MutationPhase,
  run: () => Promise<T>,
  now: () => number = performance.now.bind(performance),
): Promise<Measured<T>> => {
  const startedAt = now();
  const value = await run();
  return { timing: { durationMs: now() - startedAt, phase }, value };
};

export interface TestStageResult {
  status: Status;
  timings: PhaseTiming[];
}

type RunStage = (
  phase: "direct-tests" | "integration-tests",
  testFiles: string[],
) => Promise<{ status: Status; timings: PhaseTiming[] }>;

/** Run the narrow direct tests first and spend time on integration tests only
 * when the direct tests did not detect the mutant. */
export const runTestStages = async (
  directTestFiles: string[],
  integrationTestFiles: string[],
  run: RunStage,
): Promise<TestStageResult> => {
  const timings: PhaseTiming[] = [];
  if (directTestFiles.length > 0) {
    const direct = await run("direct-tests", directTestFiles);
    timings.push(...direct.timings);
    if (direct.status !== "survived") {
      return { status: direct.status, timings };
    }
  }
  if (integrationTestFiles.length > 0) {
    const integration = await run("integration-tests", integrationTestFiles);
    timings.push(...integration.timings);
    return { status: integration.status, timings };
  }
  return { status: "survived", timings };
};
