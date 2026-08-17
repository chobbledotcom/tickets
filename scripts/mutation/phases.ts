import type { EvaluationStatus } from "./summary.ts";

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

export type TestDetectionPhase =
  | "direct-tests"
  | "test-state"
  | "integration-tests";

export interface TestStageResult {
  detectedBy: TestDetectionPhase | null;
  status: EvaluationStatus;
  timings: PhaseTiming[];
}

type RunStage = (
  phase: "direct-tests" | "integration-tests",
  testFiles: string[],
) => Promise<TestStageResult>;

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
      return { ...direct, timings };
    }
  }
  if (integrationTestFiles.length > 0) {
    const integration = await run("integration-tests", integrationTestFiles);
    timings.push(...integration.timings);
    return { ...integration, timings };
  }
  return { detectedBy: null, status: "survived", timings };
};
