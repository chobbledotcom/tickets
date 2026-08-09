import { readSlowTestsReport } from "#scripts/test-durations.ts";
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
  name: string;
  progress?: (line: string) => string | undefined;
  summary?: StepSummary;
}

export const getSteps = (): Step[] => {
  const deno = Deno.execPath();
  return [
    // Always run read-only `lint:ci` (Deno Markdown + Biome code checks) so
    // local precommit is exactly as strict as CI without changing the checkout.
    // Run `deno task lint` separately to auto-fix formatting before committing.
    { cmd: [deno, "task", "lint:ci"], name: "lint" },
    { cmd: [deno, "task", "typecheck"], name: "typecheck" },
    { cmd: [deno, "task", "cpd"], name: "cpd" },
    // Guard the user-facing copy catalog against the mechanical simple-language
    // rules (see the "Simple Language" section of AGENTS.md).
    { cmd: [deno, "task", "check:copy"], name: "check:copy" },
    // Catch a known-equivalent entry that no longer points at a real mutant on
    // the branch that moved it, rather than in review. Resolution only — the
    // audit that re-proves equivalence runs lint and type-check per entry and
    // stays an on-demand tool.
    { cmd: [deno, "task", "check:equivalents"], name: "check:equivalents" },
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
