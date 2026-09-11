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

const STEPS = [
  // Always run read-only `lint:ci` (Deno Markdown + Biome code checks) so
  // local precommit is exactly as strict as CI without changing the checkout.
  // Run `deno task lint` separately to auto-fix formatting before committing.
  { cmd: ["task", "lint:ci"], name: "lint" },
  { cmd: ["task", "typecheck"], name: "typecheck" },
  // An exact baseline and reviewed false positives turn the whole-repository
  // field scan into a ratchet. It follows typecheck because it asks the same
  // compiler program which symbol each mention reaches.
  {
    cmd: ["task", "check:unread-fields"],
    name: "check:unread-fields",
  },
  { cmd: ["task", "cpd"], name: "cpd" },
  // The half of duplication jscpd cannot see: two functions with one shape
  // and different names. jscpd compares tokens as written, so a rename hides
  // a copy from it (see "Code Duplication" in AGENTS.md).
  { cmd: ["task", "check:shapes"], name: "check:shapes" },
  // Guard the user-facing copy catalog against the mechanical simple-language
  // rules (see the "Simple Language" section of AGENTS.md).
  { cmd: ["task", "check:copy"], name: "check:copy" },
  // Hold comments to the length and width limits, which the formatter cannot
  // do — Biome never reflows comment text (see "Comments are short" in
  // AGENTS.md, and docs/comment-policy.md for how the limits ratchet down).
  { cmd: ["task", "check:comments"], name: "check:comments" },
  // Keep one module to one name: no file importing the same module twice, and
  // no import spelling a module longer than its own alias allows (see
  // "Imports name a module one way" in AGENTS.md).
  { cmd: ["task", "check:imports"], name: "check:imports" },
  // Hold the payment e2e to the catalog's own words: every label it clicks
  // or asserts must be copy src/locales/en renders (or a t("…") call), so a
  // copy rename fails here instead of the schedule-only nightly run.
  {
    cmd: ["task", "check:e2e-labels"],
    name: "check:e2e-labels",
  },
  // Catch a known-equivalent entry that no longer points at a real mutant on
  // the branch that moved it, rather than in review. Resolution only — the
  // audit that re-proves equivalence runs lint and type-check per entry and
  // stays an on-demand tool.
  { cmd: ["task", "check:equivalents"], name: "check:equivalents" },
  { cmd: ["task", "build:edge"], name: "build:edge" },
  {
    cmd: ["task", "test:coverage"],
    filterOutput: filterTestOutput,
    name: "test:coverage",
    progress: testProgressFromLine,
    summary: async (): Promise<string | undefined> => {
      const { readSlowTestsReport } = await import(
        "#scripts/test-durations.ts"
      );
      return (await readSlowTestsReport()) || undefined;
    },
  },
] as const;

export const PRECOMMIT_STEP_NAMES = STEPS.map((step) => step.name);

export const getSteps = (): Step[] => {
  const deno = Deno.execPath();
  return STEPS.map((step) => ({ ...step, cmd: [deno, ...step.cmd] }));
};
