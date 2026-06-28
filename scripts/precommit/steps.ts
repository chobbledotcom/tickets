import { readSlowTestsReport } from "../test-durations.ts";
import { filterTestOutput, testProgressFromLine } from "./output.ts";

/**
 * Optional always-shown summary for a step. Invoked after the step finishes
 * (on success only) and printed verbatim — used by the test step to surface the
 * slow-tests report, which the step writes to a JUnit file but whose stdout is
 * otherwise swallowed on success.
 */
export type StepSummary = (
  stdout: string,
  stderr: string,
) => string | undefined | Promise<string | undefined>;

export interface Step {
  cmd: string[];
  filterOutput?: (stdout: string, stderr: string) => string;
  progress?: (line: string) => string | undefined;
  summary?: StepSummary;
  name: string;
}

export const getSteps = (): Step[] => {
  const deno = Deno.execPath();
  return [
    // Always run the read-only `lint:ci` (Biome `check --error-on-warnings`) so
    // precommit is exactly as strict locally as in CI: it fails on lint warnings
    // and on code that *would* be reformatted, without modifying the checkout.
    // Run `deno task lint` separately to auto-fix formatting before committing.
    { cmd: [deno, "task", "lint:ci"], name: "lint" },
    { cmd: [deno, "task", "typecheck"], name: "typecheck" },
    { cmd: [deno, "task", "cpd"], name: "cpd" },
    { cmd: [deno, "task", "build:edge"], name: "build:edge" },
    {
      cmd: [deno, "task", "test:coverage"],
      filterOutput: filterTestOutput,
      name: "test:coverage",
      progress: testProgressFromLine,
      summary: async () => (await readSlowTestsReport()) || undefined,
    },
  ];
};
